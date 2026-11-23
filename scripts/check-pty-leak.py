#!/usr/bin/env python3
"""macOS live Host regression: 20 fast exits, 5 delayed exits, 5 kills.

Uses the configured tb connection. Never kills pre-existing sessions.
Exit 1 means the Host retained PTY masters after all test sessions ended.
"""
import argparse
import json
import re
import subprocess
import time


def host_usage():
    state = subprocess.check_output(['launchctl', 'list', 'com.termbridge.host'], text=True)
    pid = int(re.search(r'"PID" = (\d+)', state)[1])
    files = subprocess.run(['lsof', '-nP', '-p', str(pid)], capture_output=True, text=True, check=True).stdout
    return pid, sum('/dev/ptmx' in line for line in files.splitlines())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tb', default='tb', help='CLI executable to exercise')
    args = parser.parse_args()
    pid, baseline = host_usage()
    results = {'pid': pid, 'baseline': baseline}
    for kind, count, command in [
        ('echo', 20, ['/bin/echo', 'x']),
        ('sleep', 5, ['/bin/sh', '-c', 'sleep 1']),
        ('kill', 5, ['/bin/sh', '-c', 'sleep 30']),
    ]:
        for _ in range(count):
            proc = subprocess.Popen([args.tb, 'new', '--', *command], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                if kind == 'kill':
                    # The attached acknowledgement identifies only our new session.
                    line = proc.stdout.readline()
                    match = re.search(r'sess-\d+', line)
                    if not match:
                        raise RuntimeError('No test session acknowledgement: ' + line)
                    subprocess.run([args.tb, 'kill', match[0]], check=True, capture_output=True, timeout=10)
                output, _ = proc.communicate(timeout=15)
                if kind != 'kill' and proc.returncode != 0:
                    raise RuntimeError(f'{kind} failed: {output}')
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait()
        time.sleep(0.3)
        current_pid, used = host_usage()
        if current_pid != pid:
            raise RuntimeError('Host restarted during measurement')
        results[kind] = {'sessions': count, 'ptmx': used, 'delta': used - baseline}
        print(json.dumps({kind: results[kind]}), flush=True)
    results['leaked'] = used - baseline
    print(json.dumps(results), flush=True)
    raise SystemExit(0 if used == baseline else 1)


if __name__ == '__main__':
    main()
