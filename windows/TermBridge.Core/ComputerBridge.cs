using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json.Nodes;
namespace TermBridge.Core;

public sealed class ComputerBridge {
    public static readonly string[] AllowedTools=["Snapshot","Screenshot","Click","Type","Scroll","Move","Shortcut","App"];
    private Process? process; private int sequence,generation,busy;
    private readonly SemaphoreSlim writer=new(1,1);
    private readonly ConcurrentDictionary<int,TaskCompletionSource<JsonNode?>> pending=new();
    public bool Enabled { get; private set; }
    public JsonArray Tools { get; private set; }=[];
    public event Action? Changed;
    public async Task Enable(){
        if(process!=null)throw new InvalidOperationException("电脑协助已在启动或运行。");
        var epoch=++generation;
        var info=new ProcessStartInfo(Path.Combine(CliBridge.Runtime,"python","python.exe")){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        info.StandardOutputEncoding=System.Text.Encoding.UTF8;info.StandardErrorEncoding=System.Text.Encoding.UTF8;info.StandardInputEncoding=new System.Text.UTF8Encoding(false);
        foreach(var arg in new[]{"-m","windows_mcp","serve","--transport","stdio","--tools",string.Join(',',AllowedTools)})info.ArgumentList.Add(arg);
        info.Environment["PYTHONUTF8"]="1";info.Environment["PYTHONIOENCODING"]="utf-8";info.Environment["POSTHOG_API_KEY"]="";info.Environment["ANONYMIZED_TELEMETRY"]="false";info.Environment["WINDOWS_MCP_WATCHDOG"]="off";
        var owner=process=Process.Start(info)??throw new InvalidOperationException("无法启动电脑工具。");
        _=Read(owner);_=DrainErrors(owner);
        try{
            await Call("initialize",new JsonObject{["protocolVersion"]="2024-11-05",["capabilities"]=new JsonObject(),["clientInfo"]=new JsonObject{["name"]="termbridge-native",["version"]="0.2.2"}});
            await Write(new JsonObject{["jsonrpc"]="2.0",["method"]="notifications/initialized"},epoch);
            var result=await Call("tools/list",new JsonObject());
            if(epoch!=generation)throw new InvalidOperationException("协助已停止。");
            Tools=new JsonArray((result?["tools"]?.AsArray()??[]).Where(t=>AllowedTools.Contains(t?["name"]?.GetValue<string>())).Select(t=>t?.DeepClone()).ToArray());
            if(!Tools.Any(t=>t?["name"]?.GetValue<string>()=="Snapshot"))throw new InvalidOperationException("电脑工具尚未就绪。");
            Enabled=true;Changed?.Invoke();
        }catch{if(epoch==generation)Stop();throw;}
    }
    public void Stop(){++generation;Enabled=false;Interlocked.Exchange(ref busy,0);var old=process;process=null;try{if(old is {HasExited:false})old.Kill(true);}catch{}old?.Dispose();foreach(var waiter in pending.Values)waiter.TrySetCanceled();pending.Clear();Changed?.Invoke();}
    private async Task Write(JsonObject value,int epoch){await writer.WaitAsync();try{var owner=process;if(owner==null||epoch!=generation)throw new InvalidOperationException("协助已停止。");await owner.StandardInput.WriteLineAsync(value.ToJsonString());await owner.StandardInput.FlushAsync();}finally{writer.Release();}}
    private async Task<JsonNode?> Call(string method,JsonNode parameters){
        int epoch=generation;
        int id=Interlocked.Increment(ref sequence);var waiter=new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);pending[id]=waiter;
        try{await Write(new(){["jsonrpc"]="2.0",["id"]=id,["method"]=method,["params"]=parameters},epoch);return await waiter.Task.WaitAsync(TimeSpan.FromSeconds(30));}finally{pending.TryRemove(id,out _);}
    }
    private async Task Read(Process owner){try{while(await owner.StandardOutput.ReadLineAsync() is {} line){if(owner!=process)return;if(line.Length>12*1024*1024)throw new InvalidDataException();var msg=JsonNode.Parse(line);if(msg?["id"] is JsonValue value&&value.TryGetValue<int>(out int id)&&pending.TryRemove(id,out var waiter)){if(msg["error"]!=null)waiter.TrySetException(new InvalidOperationException("电脑工具执行失败。"));else waiter.TrySetResult(msg["result"]?.DeepClone());}}}catch{}finally{if(owner==process)Stop();}}
    private static async Task DrainErrors(Process owner){try{while(await owner.StandardError.ReadLineAsync() is {} _) {}}catch{}}
    public async Task<JsonObject> Execute(JsonObject request){
        string op=request["op"]?.GetValue<string>()??"";var args=request["args"] as JsonObject??new();
        JsonObject Fail(string message)=>new(){["ok"]=false,["error"]=message};
        if(op=="computer.tools")return new(){["ok"]=true,["data"]=new JsonObject{["platform"]="win32",["enabled"]=Enabled,["engine"]="Windows-MCP 0.8.5",["tools"]=Tools.DeepClone()}};
        if(op=="info")return new(){["ok"]=true,["data"]=new JsonObject{["platform"]="win32",["exposed"]=Enabled,["computer"]=Enabled,["exec"]=false,["fs"]="off"}};
        if(op=="exec"&&args["shell"]?.GetValue<bool>()!=true&&args["argv"] is JsonArray browserArgv){
            var words=browserArgv.Select(x=>x?.GetValue<string>()??"").ToArray();
            if(words.Length is >=3 and <=5&&words[0]=="tb"&&words[1]=="browser"&&(words[2]=="status"&&words.Length==3||words[2]=="call"&&words.Length>=4)){
                if(words.Sum(w=>w.Length)>65536)return Fail("浏览器请求过大。");
                try{var result=await BrowserBridge.Run(words.Skip(2).ToArray());return new(){["ok"]=true,["exit"]=0,["stdout"]=result.ToJsonString()};}catch{return Fail("Chrome 插件未连接、未授权或操作失败。");}
            }
        }
        if(!Enabled)return Fail("请在 Windows TermBridge 设置中点击「允许协助」。");
        string? name=null;JsonObject parameters=new();
        if(op=="computer.call"){name=args["name"]?.GetValue<string>();parameters=args["arguments"] as JsonObject??new();}
        else if(op=="exec"&&args["shell"]?.GetValue<bool>()!=true&&args["argv"] is JsonArray argv){
            var words=argv.Select(x=>x?.GetValue<string>()??"").ToArray();
            if(words.Length==3&&words[0]=="tb"&&words[1]=="computer"&&words[2]=="tools")return new(){["ok"]=true,["exit"]=0,["stdout"]=new JsonObject{["tools"]=Tools.DeepClone()}.ToJsonString()};
            if(words.Length is 4 or 5&&words[0]=="tb"&&words[1]=="computer"&&words[2]=="call"){
                name=words[3];if(words.Length==5){if(words[4].Length>65536)return Fail("工具参数过大。");try{parameters=JsonNode.Parse(words[4]) as JsonObject??throw new InvalidDataException();}catch{return Fail("工具参数必须是 JSON 对象。");}}
            }
        }
        if(parameters.ToJsonString().Length>65536)return Fail("工具参数过大。");
        if(!AllowedTools.Contains(name))return Fail("此连接仅提供已允许的桌面工具。");
        if(Interlocked.CompareExchange(ref busy,1,0)!=0)return Fail("电脑正在执行操作，请稍候。");
        int epoch=generation;
        try{var result=await Call("tools/call",new JsonObject{["name"]=name,["arguments"]=parameters.DeepClone()});if(epoch!=generation)return Fail("协助已停止。");var output=result?.ToJsonString()??"{}";if(output.Length>4*1024*1024)return Fail("结果过大，请缩小截图范围。");return new(){["ok"]=true,["exit"]=result?["isError"]?.GetValue<bool>()==true?1:0,["stdout"]=output};}
        catch(TimeoutException){if(epoch==generation)Stop();return Fail("电脑工具超时，协助已停止。");}catch{return Fail("电脑操作失败或已停止。");}
        finally{if(epoch==generation)Interlocked.Exchange(ref busy,0);Changed?.Invoke();}
    }
}
