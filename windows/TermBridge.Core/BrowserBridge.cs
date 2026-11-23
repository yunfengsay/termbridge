using System.Diagnostics;
using System.Text.Json.Nodes;
namespace TermBridge.Core;
public static class BrowserBridge {
    public static async Task<JsonObject> Run(params string[] args){
        var info=new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory,"tb.exe")){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
        info.StandardOutputEncoding=System.Text.Encoding.UTF8;info.StandardErrorEncoding=System.Text.Encoding.UTF8;
        info.ArgumentList.Add("browser");foreach(var arg in args)info.ArgumentList.Add(arg);
        using var process=Process.Start(info)??throw new InvalidOperationException("Chrome 连接组件无法启动。");
        using var limit=new CancellationTokenSource(25000);
        try{var output=process.StandardOutput.ReadToEndAsync(limit.Token);var errors=process.StandardError.ReadToEndAsync(limit.Token);await process.WaitForExitAsync(limit.Token);var text=await output;await errors;
            if(process.ExitCode!=0)throw new InvalidOperationException("Chrome 操作失败，请检查插件连接和授权。");
            return JsonNode.Parse(text) as JsonObject??throw new InvalidDataException();
        }catch{try{process.Kill(true);}catch{}throw;}
    }
}
