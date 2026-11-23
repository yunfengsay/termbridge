using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using TermBridge.Core;
int passed=0;
void Check(bool value,string label){if(!value)throw new Exception(label);passed++;Console.WriteLine("PASS "+label);}
void Reject(Action action,string label){try{action();}catch(ArgumentException){Check(true,label);return;}throw new Exception(label);}
Check(JsonSerializer.Deserialize<ConnectionStore>("{}",ConnectionStore.Json)!.SessionView=="auto","Existing settings migrate to automatic session view");
foreach(var view in new[]{"auto","chat","terminal"}){
    var settings=new ConnectionStore{SessionView=view};
    var json=JsonSerializer.Serialize(settings,ConnectionStore.Json);
    Check(JsonSerializer.Deserialize<ConnectionStore>(json,ConnectionStore.Json)!.SessionView==view,"Session view persists as "+view);
}
Check(JsonSerializer.Deserialize<ConnectionStore>("{\"sessionView\":\"future\"}",ConnectionStore.Json)!.SessionView=="auto","Unknown session view defaults to automatic");
Check(SessionViewPreference.UsesChat("auto",true)&&!SessionViewPreference.UsesChat("auto",false),"Automatic view uses the Host capability");
Check(SessionViewPreference.UsesChat("chat",true)&&!SessionViewPreference.UsesChat("chat",false),"Chat preference respects unavailable transcripts");
Check(!SessionViewPreference.UsesChat("terminal",true),"Terminal preference never subscribes to Chat on open");
Check(!SessionViewPreference.UsesChat("chat",true,false)&&SessionViewPreference.UsesChat("terminal",true,true),"Reconnect keeps the chosen view after the default changes");
Check(!SessionViewPreference.UsesChat("terminal",false,true),"Reconnect cannot restore unavailable Chat");
var secret=Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
var profile=ConnectionProfile.Parse("termbridge://pair?v=1&relay=wss%3A%2F%2Fexample.invalid%2Fr&secret="+Uri.EscapeDataString(secret)+"&host=qa-native&pin="+new string('a',64),"测试电脑","");
Check(profile.RevealSecret()==secret,"DPAPI round trip");
var serialized=JsonSerializer.Serialize(profile,ConnectionStore.Json);
Check(!serialized.Contains(secret),"No plaintext credential in persisted model");
Check(JsonSerializer.Deserialize<ConnectionProfile>(serialized,ConnectionStore.Json)!.RevealSecret()==secret,"Profile migration-compatible serialization");
Reject(()=>ConnectionProfile.Parse("termbridge://pair?v=1&relay=ws%3A%2F%2Fexample.invalid&secret="+secret,"",""),"Reject insecure pairing transport");
Reject(()=>ConnectionProfile.ValidateProxy("http://name:password@localhost:3128"),"Reject proxy credentials in URL");
Reject(()=>ConnectionProfile.Parse("tb1_"+new string('a',43),"","",hostedRelay:""),"Short pairing code requires configured hosted relay");
var shortCode=ConnectionProfile.Parse("tb1_"+new string('a',43),"","",hostedRelay:"wss://relay.example.test");Check(shortCode.RelayUrl.StartsWith("wss://relay.example.test/r/"),"Short pairing code derivation");
var command=CliBridge.Command(profile,["--host","another","ls"]);Check(command.ArgumentList.Count(x=>x=="--host")==1,"Explicit CLI host overrides selected profile");
Check(command.StandardOutputEncoding==Encoding.UTF8&&command.StandardInputEncoding!.GetPreamble().Length==0,"CLI bridge uses UTF-8 without a BOM");
var computer=new ComputerBridge();var denied=await computer.Execute(new JsonObject{["op"]="computer.call",["args"]=new JsonObject{["name"]="Click"}});
Check(denied["ok"]!.GetValue<bool>()==false,"Computer control starts denied");
computer.Stop();Check(!computer.Enabled,"Stop revokes computer control");
var chat=new ChatComposerState{Draft="第一条"};
chat.Begin("send-1","第一条",7);
Check(chat.Pending&&chat.Draft=="","Sending clears only the submitted draft");
chat.Draft="下一条草稿";
Check(!chat.Apply("send-1",6,"observed")&&chat.Pending,"Old subscription cannot confirm a send");
Check(chat.Apply("send-1",7,"observed")&&!chat.Pending&&chat.Draft=="下一条草稿","Receipt preserves the next draft");
Check(!chat.Apply("send-1",7,"delivered")&&!chat.Pending,"Late intermediate receipt cannot restart the spinner");
chat.Begin("send-2","相同文本",8);chat.LoseConfirmation("offline");
Check(!chat.Pending&&!chat.Retryable&&chat.Draft=="相同文本","Disconnect preserves text as uncertain without automatic retry");
Check(chat.Apply("send-2",8,"observed")&&chat.State=="observed"&&chat.Draft=="","Late confirmation removes only an untouched recovered draft");
chat.Begin("send-3","相同文本",9);
Check(!chat.Apply("send-2",8,"observed")&&chat.Pending,"Identical prompts retain distinct request identity");
chat.Apply("send-3",9,"failed","rejected before write");
Check(chat.Retryable&&!chat.Pending&&chat.Draft=="相同文本","Only explicit pre-write rejection offers retry");
var otherChat=new ChatComposerState{Draft="另一个会话"};
Check(otherChat.Draft=="另一个会话"&&!otherChat.Pending,"Inactive conversation does not inherit pending delivery");
await using(var disconnected=new CliBridge()){
    try{await disconnected.Send(new{op="chat-send"});throw new Exception("Disconnected CLI silently accepted a request");}
    catch(CliUnavailableException){Check(true,"Disconnected CLI rejects before writing");}
}
Console.WriteLine($"{passed} native core checks passed");
