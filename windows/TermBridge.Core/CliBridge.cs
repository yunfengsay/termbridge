using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
namespace TermBridge.Core;

public sealed class CliUnavailableException(string message):InvalidOperationException(message);

public sealed class CliBridge : IAsyncDisposable {
    private Process? process;
    private readonly SemaphoreSlim writeLock=new(1,1);
    public event Action<JsonObject>? Message;
    public static string Runtime => Path.Combine(AppContext.BaseDirectory,"runtime");
    public static ProcessStartInfo Command(ConnectionProfile? profile, IEnumerable<string> args, bool redirect=true) {
        var info=new ProcessStartInfo(Path.Combine(Runtime,"node","node.exe")){UseShellExecute=false,CreateNoWindow=redirect,RedirectStandardInput=redirect,RedirectStandardOutput=redirect,RedirectStandardError=redirect};
        if(redirect){info.StandardOutputEncoding=System.Text.Encoding.UTF8;info.StandardErrorEncoding=System.Text.Encoding.UTF8;info.StandardInputEncoding=new System.Text.UTF8Encoding(false);}
        var arguments=args.ToArray();
        info.ArgumentList.Add(Path.Combine(Runtime,"tb","dist","cli.js"));
        info.Environment["PATH"]=Path.Combine(Runtime,"node")+Path.PathSeparator+Environment.GetEnvironmentVariable("PATH");
        if(profile?.HostId.Length>0&&!arguments.Contains("--host")&&!arguments.Contains("-H")){info.ArgumentList.Add("--host");info.ArgumentList.Add(profile.HostId);}
        foreach(var arg in arguments)info.ArgumentList.Add(arg);
        info.Environment["NO_COLOR"]="1";
        if(profile!=null){info.Environment["RELAY_URL"]=profile.RelayUrl;info.Environment["TB_SECRET"]=profile.RevealSecret();info.Environment["TB_TLS_PIN"]=profile.Pin;
            info.Environment["TB_DESKTOP_DEVICE_ID"]="windows-"+profile.Id;
            foreach(var key in new[]{"HTTPS_PROXY","HTTP_PROXY","ALL_PROXY","https_proxy","http_proxy","all_proxy"})info.Environment.Remove(key);
            if(profile.Proxy.Length>0){info.Environment["HTTPS_PROXY"]=profile.Proxy;info.Environment["HTTP_PROXY"]=profile.Proxy;}}
        return info;
    }
    public void Start(ConnectionProfile profile){
        process=Process.Start(Command(profile,["desktop"]))??throw new InvalidOperationException("无法启动 TB CLI。");
        _=ReadOutput(process);_=ReadErrors(process);
    }
    private async Task ReadOutput(Process owner){
        try{while(await owner.StandardOutput.ReadLineAsync() is {} line){if(process!=owner)return;if(line.Length>24*1024*1024)throw new InvalidDataException();if(JsonNode.Parse(line) is JsonObject msg)Message?.Invoke(msg);}}
        catch{if(process==owner)Message?.Invoke(new(){["event"]="error",["message"]="CLI 输出中断，请重新连接。"});}
        finally{if(process==owner)Message?.Invoke(new(){["event"]="status",["status"]="offline"});}
    }
    private async Task ReadErrors(Process owner){
        try{while(await owner.StandardError.ReadLineAsync() is {} _){if(process!=owner)return;Message?.Invoke(new(){["event"]="error",["message"]="CLI 无法连接，请检查网络、配对与证书指纹。"});}}catch{}
    }
    public async Task Send(object request){
        await writeLock.WaitAsync();
        try{
            if(process is not {HasExited:false} current)throw new CliUnavailableException("CLI 连接已关闭，请重新连接。");
            await current.StandardInput.WriteLineAsync(JsonSerializer.Serialize(request));
            await current.StandardInput.FlushAsync();
        }finally{writeLock.Release();}
    }
    public async ValueTask DisposeAsync(){var old=process;process=null;if(old==null)return;try{old.StandardInput.Close();using var deadline=new CancellationTokenSource(2000);await old.WaitForExitAsync(deadline.Token);}catch{try{old.Kill(true);}catch{}}old.Dispose();}
    public static async Task<string> Version(){using var process=Process.Start(Command(null,["--version"]))??throw new InvalidOperationException();using var timeout=new CancellationTokenSource(10000);try{var errors=process.StandardError.ReadToEndAsync(timeout.Token);var output=await process.StandardOutput.ReadToEndAsync(timeout.Token);await process.WaitForExitAsync(timeout.Token);await errors;return process.ExitCode==0?output.Trim():"不可用，请重新安装";}catch{try{process.Kill(true);}catch{}throw;}}
}
