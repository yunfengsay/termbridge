using System.Diagnostics;
using TermBridge.Core;
try {
    // Chrome launches Native Messaging hosts with its extension origin as argv[0].
    bool native=args.Length>0&&args[0].StartsWith("chrome-extension://",StringComparison.Ordinal);
    if(native||(args.Length>0&&args[0]=="browser")){
        var command=new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory,"runtime","node","node.exe")){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        command.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory,"browser-extension","bridge.mjs"));
        foreach(var arg in native?new[]{"native-host"}:args.Skip(1))command.ArgumentList.Add(arg);
        command.Environment["TB_BROWSER_NATIVE_EXE"]=Path.Combine(AppContext.BaseDirectory,"tb.exe");
        using var browser=Process.Start(command)??throw new InvalidOperationException();
        using var ended=new CancellationTokenSource();
        var output=browser.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var errors=browser.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        if(native)_=Console.OpenStandardInput().CopyToAsync(browser.StandardInput.BaseStream,ended.Token);
        else browser.StandardInput.Close();
        await browser.WaitForExitAsync();ended.Cancel();await Task.WhenAll(output,errors);return browser.ExitCode;
    }
    Console.InputEncoding=System.Text.Encoding.UTF8;Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    var profile=string.IsNullOrEmpty(Environment.GetEnvironmentVariable("TB_SETTINGS"))&&string.IsNullOrEmpty(Environment.GetEnvironmentVariable("RELAY_URL"))?ConnectionStore.Load().Active:null;
    using var child=Process.Start(CliBridge.Command(profile,args,redirect:false));
    if(child==null)return 1;
    Console.CancelKeyPress+=(_,e)=>e.Cancel=true;
    await child.WaitForExitAsync();return child.ExitCode;
}catch{Console.Error.WriteLine("TermBridge: 无法读取连接或启动 CLI，请打开 App 检查设置。");return 1;}
