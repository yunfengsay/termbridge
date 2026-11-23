import { cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function renderSite(output, manifest) {
  await cp(resolve(site, 'public'), output, { recursive: true });
  const { cli, android, macos, windows } = manifest;
  const size = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const values = { CLI_VERSION: cli.version, CLI_URL: cli.url, ANDROID_VERSION: android.version, ANDROID_URL: android.url, ANDROID_SIZE: size(android.size), MACOS_VERSION: macos.version, MACOS_URL: macos.url, MACOS_SIZE: size(macos.size) };
  const desktopReady = /^\d+$/.test(String(macos.build)) && Number(macos.build) >= 14;
  const atLeast = (version, minimum) => {
    const a = version.split('.').map(Number), b = minimum.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
    return true;
  };
  values.MACOS_FEATURES = desktopReady
    ? '内置交互终端、多连接源标签、可收起的文件目录树。设置中安装 CLI、创建扫码配对和管理本机 Host，无需管理员密码。'
    : '内置交互终端、多连接源标签和连接设置。支持粘贴截图、添加图片附件，随时切换到另一台 Mac。';
  values.MACOS_RELEASE_NOTE = desktopReady
    ? '新版已加入自动安装 CLI、手机扫码配对与文件目录树。远端文件浏览和原生滚动需 Host 0.1.26 或更新版本。'
    : '0.3.10 待发布：自动安装 CLI、手机扫码配对、可收起的文件目录树与原生滚动。当前下载为下方标注的正式版本。';
  // Announced only from the release that actually ships the setting, so an older
  // Mac build cannot inherit the sentence.
  if (atLeast(macos.version, '0.3.14')) {
    values.MACOS_RELEASE_NOTE += ' 本版新增设置里的「新会话默认视图」：自动选择 / 对话优先 / 终端优先，默认自动选择，窗口内也能切换。';
  }
  values.CLI_APP_INSTALL_NOTE = atLeast(cli.version, '0.1.26')
    ? 'Mac 用户可运行 tb app install 安装桌面 App；tb app status 检测安装，tb app open 打开 App。'
    : 'CLI 0.1.26 待发布：将支持 tb app install 安装 Mac App、tb app status 检测安装，以及 tb app open 打开 App。';
  values.CLI_SETUP_INTRO = desktopReady
    ? 'Mac 可先下载 App，由设置自动安装 CLI。已有 Node.js 的电脑也可执行：'
    : '准备好 Node.js，打开 Terminal 执行：';
  values.PAIRING_SETUP_INTRO = desktopReady
    ? 'Mac App 设置 → 命令行与 Host，可创建配对并启动 Host；CLI 也支持下方命令。配对码请按密码保管。'
    : '电脑通过官方中继连接。将显示的配对码按密码保管。';
  if (atLeast(macos.version, '0.3.16')) {
    values.MACOS_FEATURES = '内置 Host，设置中选择本机 IP、端口和密码即可开启内网服务。手机和其他 Mac 使用自签名 TLS 直连，也可添加多台服务器。';
    values.MACOS_RELEASE_NOTE = '新增「内网服务」和「内网直连」设置，无需另装 Node.js 或运行命令。支持扫码配对、登录 Mac 时启动，以及打开 App 时恢复内网服务。';
    values.CLI_SETUP_INTRO = 'Mac 可直接使用 App 内置的内网服务。需要独立 CLI 的电脑也可执行：';
    values.PAIRING_SETUP_INTRO = 'Mac App 设置 → 内网服务，选择本机 IP 并开启服务，再用手机扫码配对；连接其他 Mac 时选择「内网直连」。';
  }
  values.MACOS_SIGNING_SUMMARY = macos.notarized === true
    ? '已使用 Developer ID 签名，并通过 Apple 公证。'
    : '当前为预览版，尚未完成 Apple 公证。';
  values.MACOS_INSTALL_SECURITY = macos.notarized === true
    ? '当前包适用于 Apple Silicon，已使用 Developer ID 签名并通过 Apple 公证。首次打开时，macOS 仍可能询问是否打开从互联网下载的 App。'
    : '当前包适用于 Apple Silicon，采用临时签名，尚未经过 Apple 公证。若系统阻止打开，请先确认下载来源和校验值，再按系统「隐私与安全性」中的提示操作。';
  values.MACOS_FORMAT = (macos.format || 'dmg').toUpperCase();
  values.MACOS_INSTALL_STEP = macos.format === 'zip'
    ? '解压下载的 ZIP，将 TermBridge 拖到「应用程序」。'
    : '打开下载的 DMG，将 TermBridge 拖到「应用程序」。';
  values.MACOS_CHANNEL = macos.notarized === true ? '正式签名版' : '预览版';
  let template = await readFile(resolve(site, 'public/index.html'), 'utf8');
  // The Windows card only exists when a real installer shipped in this release,
  // so a release without one cannot leave a stale download on the page.
  if (windows?.file) {
    values.WINDOWS_VERSION = windows.version;
    values.WINDOWS_URL = windows.url;
    values.WINDOWS_SIZE = size(windows.size);
    values.WINDOWS_BUNDLED_CLI = windows.bundledCLI
      ? `随包内置离线 CLI ${windows.bundledCLI}，其中包含 Agent 对话所需的 Host 能力。`
      : '随包内置离线 CLI 作为本机桥接。';
  } else {
    template = template.replace(/<!--WINDOWS_CARD_START-->[\s\S]*?<!--WINDOWS_CARD_END-->/, '');
  }
  // Each platform gained the session-interface setting in a different release, so
  // the copy names only the downloads on this page that actually carry it. A
  // release that ships an older build of one platform cannot leave the FAQ
  // claiming a setting that download does not have.
  const sessionUI = [
    atLeast(macos.version, '0.3.14') && `macOS ${macos.version}（自动选择 / 对话优先 / 终端优先）`,
    atLeast(android.version, '0.1.25') && `Android ${android.version}（自动选择 / 对话 / 终端）`,
    windows?.file && atLeast(windows.version, '0.2.3') && `Windows ${windows.version}（自动 / 对话优先 / 终端）`,
  ].filter(Boolean);
  values.SESSION_UI_PLATFORMS = sessionUI.length
    ? `本页的 ${sessionUI.join('、')}提供这个设置，括号内是各端的选项名称。`
    : '本页当前的下载都还不包含这个设置。';
  // The chat view reads from the Host on the machine running the Agent, which is
  // a separate upgrade from any client on this page.
  values.SESSION_UI_HOST_NOTE = atLeast(cli.version, '0.1.27')
    ? `本页的 CLI ${cli.version} 已包含该能力。`
    : `本页提供的 CLI ${cli.version} 尚未包含该能力，带此能力的版本仍在发布中。`;
  values.SESSION_UI_WINDOWS_NOTE = windows?.file && windows.bundledCLI
    ? `Windows 安装包内置的离线 CLI 已是 ${windows.bundledCLI}，但它只是这台 Windows 自己的 Host；装上 Windows 客户端不会升级远端那台电脑的 Host。`
    : '';
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing template variable ${key}`);
    return String(values[key]).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  });
  await writeFile(resolve(output, 'index.html'), html);
  await writeFile(resolve(output, 'downloads/index.html'), html);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = resolve(site, 'dist');
  const manifest = JSON.parse(await readFile(resolve(output, 'downloads/manifest.json'), 'utf8'));
  await renderSite(output, manifest);
  console.log('Rendered site using existing verified release artifacts.');
}
