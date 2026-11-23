using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.Web.WebView2.Core;
using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using TermBridge.Core;
namespace TermBridge.App;

public sealed record SessionItem(string Id,string Name,string Detail,string Status){public override string ToString()=>Name;}
/// <summary>Whether a session can be shown as a conversation, and why not.</summary>
public sealed record ChatAvailability(bool Chat,string? Reason);
public sealed partial class MainWindow : Window {
    private ConnectionStore store=new(); private CliBridge? bridge; private readonly ComputerBridge computer=new();
    private readonly ObservableCollection<SessionItem> sessions=[];
    private List<SessionItem> allSessions=[]; private List<string> agents=[];
    private bool initialized, updatingList, updatingNavigation, dialogOpen, webReady, connected;
    private string? activeSession;private Hotkey? hotkey;
    // Chat is a second view of the SAME session. `selectedSession` is what the
    // list points at; `activeSession` is what the terminal is attached to. They
    // differ on purpose: opening a conversation must not attach a terminal, and
    // therefore must not touch the pane's focus on the host machine.
    private bool chatWebReady, chatMode=true, updatingComposer, updatingViewButtons, creatingSession;
    private string? selectedSession, reconnectSession;
    private bool reconnectChatMode;
    private int chatGeneration, selectionRevision, imeGeneration, composerFocusGeneration=-1;
    private bool imeComposing;
    private readonly Dictionary<string,ChatAvailability> chatAvailability=[];
    // Drafts are per session and local to this computer, so switching sessions
    // — or switching to another device — never loses what was being typed.
    private readonly Dictionary<string,ChatComposerState> composers=[];
    private ChatComposerState ComposerState(string sessionId){
        var key=(store.ActiveProfile??"")+"\0"+sessionId;
        if(!composers.TryGetValue(key,out var state))composers[key]=state=new();
        return state;
    }
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? timer;
    public MainWindow(){
        InitializeComponent();ExtendsContentIntoTitleBar=true;SetTitleBar(TitleArea);
        var area=DisplayArea.GetFromWindowId(AppWindow.Id,DisplayAreaFallback.Primary).WorkArea;
        int width=Math.Min(1180,area.Width),height=Math.Min(800,area.Height);
        AppWindow.MoveAndResize(new Windows.Graphics.RectInt32(area.X+(area.Width-width)/2,area.Y+(area.Height-height)/2,width,height));AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory,"Assets","icon.ico"));
        SessionList.ItemsSource=sessions;
        Navigation.DisplayModeChanged+=(_,e)=>HostFooter.Visibility=e.DisplayMode==NavigationViewDisplayMode.Expanded?Visibility.Visible:Visibility.Collapsed;
        Workspace.SizeChanged+=(_,_)=>ApplySessionWidth();
        Root.AddHandler(UIElement.PointerMovedEvent,new PointerEventHandler(DividerPointerMoved),true);
        Root.AddHandler(UIElement.PointerReleasedEvent,new PointerEventHandler(DividerPointerReleased),true);
        Root.AddHandler(UIElement.PointerCanceledEvent,new PointerEventHandler(DividerPointerReleased),true);
        TerminalView.GotFocus+=(_,_)=>Post(new{@event="focus"});
        ComposerBox.TextCompositionStarted+=(_,_)=>{imeComposing=true;imeGeneration++;};
        ComposerBox.TextCompositionEnded+=(_,_)=>{
            int generation=imeGeneration;
            // The commit key may still be bubbling during TextCompositionEnded.
            DispatcherQueue.TryEnqueue(()=>{if(generation==imeGeneration)imeComposing=false;});
        };
        Root.ActualThemeChanged+=(_,_)=>PostChat(new{op="theme",theme=Root.ActualTheme==ElementTheme.Dark?"dark":"light"});
        Root.Loaded+=Loaded;Root.ActualThemeChanged+=(_,_)=>UpdateTitleBar();UpdateTitleBar();
        Closed+=async(_,_)=>{timer?.Stop();hotkey?.Dispose();computer.Stop();if(bridge!=null)await bridge.DisposeAsync();};
        computer.Changed+=()=>DispatcherQueue.TryEnqueue(UpdatePermission);
    }
    private void UpdateTitleBar(){
        var bar=AppWindow.TitleBar;bool dark=Root.ActualTheme==ElementTheme.Dark;
        bar.ButtonBackgroundColor=Colors.Transparent;bar.ButtonInactiveBackgroundColor=Colors.Transparent;
        bar.ButtonForegroundColor=dark?Colors.White:Colors.Black;
        bar.ButtonHoverForegroundColor=bar.ButtonForegroundColor;
        bar.ButtonPressedForegroundColor=bar.ButtonForegroundColor;
        bar.ButtonInactiveForegroundColor=dark?ColorHelper.FromArgb(255,160,160,160):ColorHelper.FromArgb(255,100,100,100);
        bar.ButtonHoverBackgroundColor=dark?ColorHelper.FromArgb(255,60,60,60):ColorHelper.FromArgb(255,230,230,230);
        bar.ButtonPressedBackgroundColor=dark?ColorHelper.FromArgb(255,75,75,75):ColorHelper.FromArgb(255,210,210,210);
    }
    private async void Loaded(object sender,RoutedEventArgs args){
        if(initialized)return;initialized=true;
        try{
            store=ConnectionStore.Load();ApplySessionWidth();ThemePicker.SelectedIndex=Math.Clamp(store.Theme,0,2);
            SessionViewPicker.SelectedIndex=store.SessionView switch{SessionViewPreference.Chat=>1,SessionViewPreference.Terminal=>2,_=>0};
            PopulateProfiles();
            hotkey=new Hotkey(WinRT.Interop.WindowNative.GetWindowHandle(this),()=>DispatcherQueue.TryEnqueue(()=>computer.Stop()));
            await InitializeTerminal();
            // The conversation surface is optional: if it cannot load, the app
            // still runs as a terminal client and simply never offers chat.
            try{await InitializeChat();}catch(Exception e){chatWebReady=false;ShowError("对话视图不可用，将只使用终端："+e.Message);}
            if(store.Active!=null)await SelectProfile(store.Active);else ShowEmpty();
            CliStatus.Text=await CliBridge.Version();await UpdateBrowserStatus();
            timer=DispatcherQueue.CreateTimer();timer.Interval=TimeSpan.FromSeconds(10);timer.Tick+=async(_,_)=>{if(connected&&AppWindow.IsVisible)await Send(new{op="refresh"});};timer.Start();
        }catch(Exception e){ShowError(e.Message);}
    }
    private async Task InitializeTerminal(){
        var cache=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"TermBridge","WebView2");
        var environment=await CoreWebView2Environment.CreateWithOptionsAsync(null,cache,null);
        await TerminalView.EnsureCoreWebView2Async(environment);
        var core=TerminalView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreDevToolsEnabled=false;core.Settings.IsStatusBarEnabled=false;
        core.SetVirtualHostNameToFolderMapping("terminal.termbridge.local",Path.Combine(AppContext.BaseDirectory,"Terminal"),CoreWebView2HostResourceAccessKind.DenyCors);
        core.NavigationStarting+=(_,e)=>{if(!e.Uri.StartsWith("https://terminal.termbridge.local/",StringComparison.Ordinal))e.Cancel=true;};
        core.NewWindowRequested+=(_,e)=>e.Handled=true;
        core.PermissionRequested+=(_,e)=>e.State=CoreWebView2PermissionState.Deny;
        core.WebMessageReceived+=async(_,e)=>{
            try{
                if(e.Source!="https://terminal.termbridge.local/index.html")return;
                var message=JsonNode.Parse(e.WebMessageAsJson);var op=message?["op"]?.GetValue<string>();
                if(op=="ready"){webReady=true;return;}
                if(op=="paste"&&bridge!=null){
                    var clipboard=Windows.ApplicationModel.DataTransfer.Clipboard.GetContent();
                    if(clipboard.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text)){
                        var text=await clipboard.GetTextAsync();
                        if(System.Text.Encoding.UTF8.GetByteCount(text)>65536){ShowError("粘贴内容超过 64 KB，请分段粘贴。");return;}
                        Post(new{@event="paste",text});
                    }return;
                }
                if(op=="copy"){
                    var data=new Windows.ApplicationModel.DataTransfer.DataPackage();data.SetText(message?["data"]?.GetValue<string>()??"");
                    Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data);return;
                }
                if((op is "input" or "resize")&&bridge!=null&&!chatMode&&selectedSession==activeSession&&activeSession!=null)await bridge.Send(message!);
            }catch{ShowError("终端输入未能发送，请检查连接。");}
        };
        core.Navigate("https://terminal.termbridge.local/index.html");
        for(int i=0;i<100&&!webReady;i++)await Task.Delay(50);
        if(!webReady)throw new InvalidOperationException("终端组件未能加载，请检查 WebView2 Runtime。");
    }
    private async Task InitializeChat(){
        // Both local surfaces share one WebView2 browser process and lifecycle.
        await ChatView.EnsureCoreWebView2Async(TerminalView.CoreWebView2.Environment);
        var core=ChatView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreDevToolsEnabled=false;core.Settings.IsStatusBarEnabled=false;
        core.SetVirtualHostNameToFolderMapping("chat.termbridge.local",Path.Combine(AppContext.BaseDirectory,"Chat"),CoreWebView2HostResourceAccessKind.DenyCors);
        core.NavigationStarting+=(_,e)=>{if(!e.Uri.StartsWith("https://chat.termbridge.local/",StringComparison.Ordinal))e.Cancel=true;};
        core.NewWindowRequested+=(_,e)=>e.Handled=true;
        core.PermissionRequested+=(_,e)=>e.State=CoreWebView2PermissionState.Deny;
        core.WebMessageReceived+=(sender,e)=>{
            try{
                if(e.Source!="https://chat.termbridge.local/index.html")return;
                var message=JsonNode.Parse(e.WebMessageAsJson);
                switch(message?["op"]?.GetValue<string>()){
                    case "ready":chatWebReady=true;PostChat(new{op="theme",theme=Root.ActualTheme==ElementTheme.Dark?"dark":"light"});break;
                    case "earlier":
                        // Only the view the user is on may page its own history.
                        if(message["generation"]?.GetValue<int>()==chatGeneration&&selectedSession is {} id)
                            _=Send(new{op="chat-earlier",requestId=NewRequestId(),conversationId=id,generation=chatGeneration,cursor=message["cursor"]?.GetValue<long>()??0});
                        break;
                    case "copy":{
                        var data=new Windows.ApplicationModel.DataTransfer.DataPackage();data.SetText(message["data"]?.GetValue<string>()??"");
                        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data);break;
                    }
                    case "open":{
                        var url=message["url"]?.GetValue<string>();
                        // A transcript is untrusted text: only a plain web link opens, and it opens outside the app.
                        if(url!=null&&Uri.TryCreate(url,UriKind.Absolute,out var target)&&(target.Scheme=="https"||target.Scheme=="http"))
                            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target.ToString()){UseShellExecute=true});
                        break;
                    }
                }
            }catch{ShowError("对话视图消息无效。");}
        };
        core.Navigate("https://chat.termbridge.local/index.html");
        for(int i=0;i<100&&!chatWebReady;i++)await Task.Delay(50);
        if(!chatWebReady)throw new InvalidOperationException("对话组件未能加载，请检查 WebView2 Runtime。");
    }
    private static string NewRequestId()=>Guid.NewGuid().ToString("N");
    private void PostChat(object message){if(chatWebReady)ChatView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));}
    private void PopulateProfiles(){
        updatingNavigation=true;
        try{
        foreach(var item in Navigation.MenuItems.OfType<NavigationViewItem>().Where(i=>i.Tag is ConnectionProfile).ToList())Navigation.MenuItems.Remove(item);
        int index=1;
        foreach(var profile in store.Profiles){var item=new NavigationViewItem{Content=profile.Name,Icon=new SymbolIcon(Symbol.AllApps),Tag=profile};Navigation.MenuItems.Insert(index++,item);}
        Navigation.SelectedItem=Navigation.MenuItems.OfType<NavigationViewItem>().FirstOrDefault(i=>i.Tag is ConnectionProfile p&&p.Id==store.ActiveProfile);
        }finally{updatingNavigation=false;}
    }
    private async Task SelectProfile(ConnectionProfile profile){
        SaveDraft();LoseConfirmation("连接已切换，发送结果未知。");selectionRevision++;reconnectSession=null;creatingSession=false;
        computer.Stop();connected=false;activeSession=null;NewButton.IsEnabled=false;AssistanceButton.IsEnabled=false;ErrorBar.IsOpen=false;
        // The CLI connection is being replaced, so its subscriptions die with it;
        // drafts are keyed by session and deliberately survive the switch.
        chatAvailability.Clear();ClearChat();ShowEmpty();
        int revision=selectionRevision;
        var old=bridge;bridge=null;if(old!=null)await old.DisposeAsync();
        if(revision!=selectionRevision)return;
        store.ActiveProfile=profile.Id;store.Save();ProxyBox.Text=profile.Proxy;PageTitle.Text=profile.Name;ConnectionStatus.Text="正在连接…";allSessions=[];FilterSessions();
        SettingsPage.Visibility=Visibility.Collapsed;Workspace.Visibility=Visibility.Visible;
        var current=bridge=new CliBridge();current.Message+=msg=>DispatcherQueue.TryEnqueue(()=>HandleMessage(current,msg));current.Start(profile);
    }
    private async void HandleMessage(CliBridge origin,JsonObject message){
        if(origin!=bridge)return;
        try{
            switch(message["event"]?.GetValue<string>()){
                case "config":
                    agents=message["agents"]?.AsArray().Select(x=>x!.GetValue<string>()).ToList()??[];
                    if(store.Active is {} p&&p.HostId.Length==0){p.HostId=message["hostId"]?.GetValue<string>()??"";p.Name=message["hostName"]?.GetValue<string>()??p.Name;store.Save();PopulateProfiles();PageTitle.Text=p.Name;}
                    break;
                case "hosts":{
                    if(store.Active is {} selected&&message["data"] is JsonObject data){
                        foreach(var host in data["hosts"]?.AsArray()??[]){var id=host?["hostId"]?.GetValue<string>();if(string.IsNullOrEmpty(id)||store.Profiles.Any(p=>p.RelayUrl==selected.RelayUrl&&p.HostId==id))continue;
                            if(selected.HostId.Length==0&&id==data["selectedHostId"]?.GetValue<string>()){selected.HostId=id;selected.Name=host?["name"]?.GetValue<string>()??id;}
                            else store.Profiles.Add(selected with{Id=Guid.NewGuid().ToString(),HostId=id,Name=host?["name"]?.GetValue<string>()??id});
                        }store.Save();PopulateProfiles();
                    }break;}
                case "status": {
                    var status=message["status"]?.GetValue<string>();connected=status is "ready" or "attaching";
                    ConnectionStatus.Text=status switch{"ready"=>$"已连接 · {allSessions.Count} 个会话","attaching"=>"正在打开会话…","connecting"=>"正在连接…",_=>"未连接，将自动重试"};
                    NewButton.IsEnabled=status=="ready";RefreshButton.IsEnabled=true;AssistanceButton.IsEnabled=connected;
                    if(status=="ready"){ErrorBar.IsOpen=false;if(activeSession!=null){activeSession=null;ShowSurface();}}
                    if(status=="offline"){
                        SaveDraft();LoseConfirmation("连接已断开，发送结果未知；不会自动重发。");
                        if(selectedSession!=null){reconnectSession=selectedSession;reconnectChatMode=chatMode;}
                        selectionRevision++;
                        computer.Stop();activeSession=null;ClearChat();ShowEmpty();
                    }if(status=="attaching"){activeSession=null;ShowSurface();}
                    break;
                }
                case "sessions":
                    allSessions=(message["sessions"]?.AsArray()??[]).Select(x=>new SessionItem(x!["sessionId"]!.GetValue<string>(),x["name"]?.GetValue<string>()??x["command"]?.GetValue<string>()??"Terminal",x["workspace"]?.GetValue<string>()??x["agent"]?.GetValue<string>()??"终端会话",StatusName(x["status"]?.GetValue<string>()))).ToList();FilterSessions();if(connected)ConnectionStatus.Text=$"已连接 · {allSessions.Count} 个会话";
                    await Send(new{op="chat-list",requestId=NewRequestId()});break;
                case "chat-list":
                    chatAvailability.Clear();
                    foreach(var entry in message["conversations"]?.AsArray()??[]){
                        var id=entry?["conversationId"]?.GetValue<string>();if(id==null)continue;
                        chatAvailability[id]=new ChatAvailability(entry?["chat"]?.GetValue<bool>()==true,entry?["reason"]?.GetValue<string>());
                    }
                    if(chatMode&&selectedSession is {} currentId&&chatAvailability.TryGetValue(currentId,out var currentAvailability)&&!currentAvailability.Chat)
                        UseTerminalFallback(currentAvailability.Reason??"对话记录暂不可用，已切换到终端。");
                    else UpdateViewAvailability();
                    if(reconnectSession is {} resume&&allSessions.Any(s=>s.Id==resume))await OpenSession(resume,reconnectChatMode);
                    break;
                case "chat-snapshot":{
                    var data=message["data"]!.AsObject();
                    // A snapshot for a conversation or generation the user has left is stale.
                    if(!IsCurrentChat(data))break;
                    ChatStatus.Text=data["error"]?.GetValue<string>()??StatusText(data["status"]?.GetValue<string>());
                    ApplyCapabilities(data["capabilities"]?.AsObject());
                    PostChat(new{op="snapshot",generation=chatGeneration,status=data["status"]?.GetValue<string>(),capabilities=data["capabilities"],messages=data["messages"],earlierCursor=data["earlierCursor"],error=data["error"]});
                    if(data["error"]!=null)UseTerminalFallback(data["error"]!.GetValue<string>());
                    else if(composerFocusGeneration==chatGeneration){composerFocusGeneration=-1;QueueComposerFocus();}
                    break;
                }
                case "chat-append":{
                    var data=message["data"]!.AsObject();
                    if(!IsCurrentChat(data))break;
                    ChatStatus.Text=StatusText(data["status"]?.GetValue<string>());
                    ApplyCapabilities(data["capabilities"]?.AsObject());
                    PostChat(new{op="append",generation=chatGeneration,status=data["status"]?.GetValue<string>(),capabilities=data["capabilities"],messages=data["messages"]});
                    break;
                }
                case "chat-earlier":{
                    var data=message["data"]!.AsObject();
                    if(!IsCurrentChat(data))break;
                    if(data["error"] is {} error){ChatStatus.Text=error.GetValue<string>();break;}
                    PostChat(new{op="earlier",generation=chatGeneration,messages=data["messages"],cursor=data["cursor"],atHead=data["atHead"]?.GetValue<bool>()??true});
                    break;
                }
                case "chat-delivery":ApplyDelivery(message["data"]!.AsObject());break;
                case "attached":
                    activeSession=message["sessionId"]?.GetValue<string>();connected=true;NewButton.IsEnabled=true;Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(TerminalView,"终端输入 · "+(allSessions.FirstOrDefault(x=>x.Id==activeSession)?.Name??"新对话"));
                    Post(new{@event="terminal-mode",native=activeSession?.StartsWith("herdr:",StringComparison.Ordinal)==true});
                    // A freshly created session opens in its terminal; an existing
                    // one only attaches because the user asked for the terminal view.
                    if(creatingSession){
                        creatingSession=false;SaveDraft();LoseConfirmation("已打开新会话，尚未确认的发送不会自动重发。");
                        if(chatMode&&selectedSession is {} previous)_=Send(new{op="chat-unsubscribe",conversationId=previous});
                        ClearChat();selectedSession=activeSession;chatMode=false;LoadDraft();
                    }
                    ShowSurface();FilterSessions();if(!chatMode&&selectedSession==activeSession)QueueTerminalFocus();break;
                case "output":case "terminal-reset":Post(message);break;
                case "tool":
                    var request=message["request"]!.AsObject();JsonObject response;
                    try{response=await computer.Execute(request);}catch{response=new(){["ok"]=false,["error"]="电脑请求无效或已取消。"};}
                    response["id"]=request["id"]?.DeepClone();if(origin==bridge)await origin.Send(new{op="tool-response",response});break;
                case "error":creatingSession=false;ShowError(message["message"]?.GetValue<string>()??"连接失败。");break;
            }
        }catch(Exception e){ShowError(e.Message);}
    }
    private static string StatusName(string? status)=>status switch{"working" or "running" or "active"=>"进行中","blocked"=>"需要处理","done"=>"已完成","waiting"=>"等待输入",_=>"可继续"};
    private void Post(object message){if(webReady)TerminalView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));}
    private void ShowEmpty(){
        selectedSession=null;
        TerminalView.Visibility=Visibility.Collapsed;ChatView.Visibility=Visibility.Collapsed;
        Composer.Visibility=Visibility.Collapsed;ViewBar.Visibility=Visibility.Collapsed;
        TerminalEmpty.Visibility=Visibility.Visible;
    }
    private void ShowError(string message){ErrorBar.Message=message;ErrorBar.IsOpen=true;}
    // Preserve containers on polling: clearing a focused ListView can steal focus from WebView2.
    private void FilterSessions(){
        updatingList=true;
        try {
            var desired=allSessions.Where(s=>string.IsNullOrWhiteSpace(Search.Text)||(s.Name+" "+s.Detail).Contains(Search.Text,StringComparison.OrdinalIgnoreCase)).ToList();
            for(int i=0;i<desired.Count;i++){
                var wanted=desired[i];int old=-1;for(int j=i;j<sessions.Count;j++)if(sessions[j].Id==wanted.Id){old=j;break;}
                if(old<0)sessions.Insert(i,wanted);else {if(old!=i)sessions.Move(old,i);if(sessions[i]!=wanted)sessions[i]=wanted;}
            }
            while(sessions.Count>desired.Count)sessions.RemoveAt(sessions.Count-1);
            var selected=sessions.FirstOrDefault(s=>s.Id==selectedSession);
            if(!Equals(SessionList.SelectedItem,selected))SessionList.SelectedItem=selected;
        } finally {updatingList=false;}
    }
    private void QueueTerminalFocus(){
        var id=activeSession;
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low,()=>{
            if(id==null||id!=activeSession||id!=selectedSession||chatMode||dialogOpen||Workspace.Visibility!=Visibility.Visible||TerminalView.Visibility!=Visibility.Visible)return;
            TerminalView.UpdateLayout();TerminalView.Focus(FocusState.Programmatic);
            Post(new{@event="focus"});
        });
    }
    private void SessionClicked(object sender,ItemClickEventArgs e){
        if(e.ClickedItem is not SessionItem item||item.Id!=selectedSession)return;
        if(chatMode)ComposerBox.Focus(FocusState.Programmatic);else QueueTerminalFocus();
    }
    private double dividerStart,dividerPointerStart;private bool dividerDragging;
    private void ApplySessionWidth(){if(Workspace.ActualWidth>0)SessionColumn.Width=new GridLength(Math.Clamp(store.SessionListWidth,144,Math.Max(144,Workspace.ActualWidth-208)));}
    private void DividerPointerPressed(object sender,PointerRoutedEventArgs e){
        if(!e.GetCurrentPoint(Workspace).Properties.IsLeftButtonPressed)return;
        dividerStart=SessionColumn.ActualWidth;dividerPointerStart=e.GetCurrentPoint(Workspace).Position.X;
        dividerDragging=true;Root.CapturePointer(e.Pointer);e.Handled=true;
    }
    private void DividerPointerMoved(object sender,PointerRoutedEventArgs e){
        if(!dividerDragging)return;
        store.SessionListWidth=Math.Clamp(dividerStart+e.GetCurrentPoint(Workspace).Position.X-dividerPointerStart,144,Math.Max(144,Workspace.ActualWidth-208));ApplySessionWidth();e.Handled=true;
    }
    private void DividerPointerReleased(object sender,PointerRoutedEventArgs e){
        if(!dividerDragging)return;dividerDragging=false;Root.ReleasePointerCaptures();
        try{store.Save();}catch{ShowError("列表宽度未能保存。");}QueueTerminalFocus();e.Handled=true;
    }
    private void DividerKeyDown(object sender,KeyRoutedEventArgs e){if(e.Key is Windows.System.VirtualKey.Left or Windows.System.VirtualKey.Right){store.SessionListWidth+=e.Key==Windows.System.VirtualKey.Left?-8:8;ApplySessionWidth();store.SessionListWidth=SessionColumn.Width.Value;try{store.Save();}catch{ShowError("列表宽度未能保存。");}e.Handled=true;}}
    private void SearchChanged(AutoSuggestBox sender,AutoSuggestBoxTextChangedEventArgs args){if(initialized)FilterSessions();}
    private async void SessionChanged(object sender,SelectionChangedEventArgs args){
        if(updatingList||SessionList.SelectedItem is not SessionItem session||bridge==null)return;
        if(session.Id==selectedSession){if(!chatMode)QueueTerminalFocus();return;}
        try{await OpenSession(session.Id);}catch(Exception e){ShowError(e.Message);}
    }
    /// <summary>
    /// Open using this computer's preference, or the view retained for a reconnect.
    /// A missing structured record opens the terminal with the reason shown.
    /// Selection, view choice, draft and scroll all stay on this computer — nothing
    /// here changes which pane the host machine has focused.
    /// </summary>
    private async Task OpenSession(string sessionId,bool? preferChat=null){
        creatingSession=false;reconnectSession=null;
        SaveDraft();
        LoseConfirmation("已离开该会话，尚未确认的发送不会自动重发。");
        var previous=selectedSession;var wasChat=chatMode;var connection=bridge;
        int revision=++selectionRevision;
        chatGeneration++;
        selectedSession=sessionId;
        chatAvailability.TryGetValue(sessionId,out var availability);
        chatMode=SessionViewPreference.UsesChat(store.SessionView,chatWebReady&&availability?.Chat==true,preferChat);
        ComposerBox.IsEnabled=false;
        LoadDraft();
        UpdateViewAvailability();
        if(previous!=null&&wasChat&&connection!=null)await connection.Send(new{op="chat-unsubscribe",conversationId=previous});
        if(revision!=selectionRevision||connection!=bridge||selectedSession!=sessionId)return;
        if(chatMode)await SubscribeChat(sessionId);
        else{
            bool wantedChat=preferChat??store.SessionView==SessionViewPreference.Chat;
            ChatStatus.Text=availability?.Reason??(wantedChat?"此会话的对话界面不可用，已打开终端。":"正在打开终端…");
            if(sessionId!=activeSession)await Send(new{op="attach",sessionId});
        }
        ShowSurface();
    }
    private async Task SubscribeChat(string sessionId){
        chatGeneration++;composerFocusGeneration=chatGeneration;
        PostChat(new{op="clear"});
        ChatStatus.Text="正在读取记录…";
        ComposerBox.IsEnabled=false;UpdateComposer();
        await Send(new{op="chat-subscribe",requestId=NewRequestId(),conversationId=sessionId,generation=chatGeneration});
    }
    private async Task UnsubscribeChat(){
        // Releasing the subscription is what frees the host's file watcher.
        if(selectedSession is {} previous&&chatMode)await Send(new{op="chat-unsubscribe",conversationId=previous});
    }
    private void ClearChat(){chatGeneration++;composerFocusGeneration=-1;PostChat(new{op="clear"});ChatStatus.Text="";ComposerBox.IsEnabled=false;ComposerSend.IsEnabled=false;ComposerHint.Text="";ComposerRetry.Visibility=Visibility.Collapsed;}
    private bool IsCurrentChat(JsonObject data)=>
        chatMode&&data["generation"]?.GetValue<int>()==chatGeneration&&data["conversationId"]?.GetValue<string>()==selectedSession;
    private static string StatusText(string? status)=>status switch{
        "loading"=>"正在读取记录…","ready"=>"可以继续对话","working"=>"Agent 正在处理",
        "empty"=>"这个会话还没有内容","unavailable"=>"对话模式不可用",_=>""};
    private void ApplyCapabilities(JsonObject? capabilities){
        bool canSend=capabilities?["send"]?.GetValue<bool>()==true;
        var reason=capabilities?["degraded"]?.GetValue<string>();
        ComposerBox.IsEnabled=canSend;
        UpdateComposer();
        // An unsupported control is disabled and explained. It is never simulated
        // with a terminal keystroke, which could answer a prompt nobody read.
        if(!canSend&&reason!=null)ComposerHint.Text=reason;
    }
    private void ApplyDelivery(JsonObject data){
        if(data["conversationId"]?.GetValue<string>() is not {} id||data["requestId"]?.GetValue<string>() is not {} requestId)return;
        var composer=ComposerState(id);
        if(!composer.Apply(requestId,data["generation"]?.GetValue<int>()??-1,data["state"]?.GetValue<string>()??"",data["error"]?.GetValue<string>()))return;
        if(id==selectedSession){LoadDraft();UpdateComposer();}
    }
    private void UpdateComposer(){
        var composer=selectedSession is {} id?ComposerState(id):null;
        var detail=composer?.Detail;
        ComposerHint.Text=composer?.State switch{
            "accepted"=>"正在发送…",
            "delivered"=>"已送入会话，等待记录确认",
            "observed"=>"已在会话记录中确认",
            "uncertain"=>"结果未知，请在终端确认后再决定是否重发"+(detail is null?"":"："+detail),
            "failed"=>"发送失败，可以重试"+(detail is null?"":"："+detail),
            _=>"",
        };
        ComposerRetry.Visibility=composer?.Retryable==true?Visibility.Visible:Visibility.Collapsed;
        ComposerSend.IsEnabled=connected&&ComposerBox.IsEnabled&&composer?.Pending!=true&&ComposerBox.Text.Trim().Length>0;
    }
    private void LoseConfirmation(string detail){
        if(selectedSession is {} id)ComposerState(id).LoseConfirmation(detail);
    }
    private void SaveDraft(){
        if(selectedSession is not {} id)return;
        ComposerState(id).Draft=ComposerBox.Text;
    }
    private void LoadDraft(){
        updatingComposer=true;
        try{ComposerBox.Text=selectedSession is {} id?ComposerState(id).Draft:"";}
        finally{updatingComposer=false;}
        UpdateComposer();
    }
    private void UpdateViewAvailability(){
        bool hasSession=selectedSession!=null;
        ViewBar.Visibility=hasSession?Visibility.Visible:Visibility.Collapsed;
        bool chatOffered=chatWebReady&&hasSession&&chatAvailability.TryGetValue(selectedSession!,out var availability)&&availability.Chat;
        ChatViewItem.IsEnabled=chatOffered;
        if(!chatOffered&&chatMode)chatMode=false;
        updatingViewButtons=true;
        try{ChatViewItem.IsChecked=chatMode;TerminalViewItem.IsChecked=!chatMode;}
        finally{updatingViewButtons=false;}
        if(!chatOffered&&hasSession&&chatAvailability.TryGetValue(selectedSession!,out var why)&&why.Reason is {} reason)ChatStatus.Text=reason;
        ShowSurface();
    }
    private void QueueComposerFocus(){
        var id=selectedSession;var generation=chatGeneration;
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low,()=>{
            if(id==selectedSession&&generation==chatGeneration&&chatMode&&ComposerBox.IsEnabled&&!dialogOpen&&Workspace.Visibility==Visibility.Visible)
                ComposerBox.Focus(FocusState.Programmatic);
        });
    }
    private async Task ShowTerminal(string id,string? reason=null){
        var connection=bridge;int revision=++selectionRevision;
        SaveDraft();LoseConfirmation("已切回终端，尚未确认的发送不会自动重发。");
        chatMode=false;ClearChat();UpdateViewAvailability();
        if(reason!=null)ChatStatus.Text=reason;
        if(connection==null)return;
        await connection.Send(new{op="chat-unsubscribe",conversationId=id});
        if(revision!=selectionRevision||connection!=bridge||id!=selectedSession||chatMode)return;
        if(id!=activeSession)await connection.Send(new{op="attach",sessionId=id});
        else QueueTerminalFocus();
    }
    private async void UseTerminalFallback(string reason){
        try{if(selectedSession is {} id)await ShowTerminal(id,reason);}catch(Exception e){ShowError(e.Message);}
    }
    private async void ViewChanged(object sender,RoutedEventArgs args){
        if(updatingViewButtons||selectedSession is not {} id)return;
        bool wantChat=ReferenceEquals(sender,ChatViewItem);
        if(wantChat==chatMode){updatingViewButtons=true;try{ChatViewItem.IsChecked=chatMode;TerminalViewItem.IsChecked=!chatMode;}finally{updatingViewButtons=false;}return;}
        try{
            if(wantChat){
                selectionRevision++;chatMode=true;UpdateViewAvailability();
                if(chatMode)await SubscribeChat(id);
            }else await ShowTerminal(id);
        }catch(Exception e){ShowError(e.Message);}
    }
    private void ComposerTextChanged(object sender,TextChangedEventArgs args){
        if(updatingComposer)return;
        SaveDraft();
        UpdateComposer();
    }
    private void ComposerKeyDown(object sender,KeyRoutedEventArgs args){
        // VK_PROCESSKEY has no named member in the WinRT VirtualKey enum.
        // Committing a Chinese candidate with Enter must never send the message.
        if(imeComposing||(int)args.Key==0xE5)return;
        if(args.Key!=Windows.System.VirtualKey.Enter)return;
        var shift=Microsoft.UI.Input.InputKeyboardSource
            .GetKeyStateForCurrentThread(Windows.System.VirtualKey.Shift)
            .HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
        if(shift)return;
        args.Handled=true;
        SendComposer(ComposerBox.Text);
    }
    private void ComposerSendClicked(object sender,RoutedEventArgs args)=>SendComposer(ComposerBox.Text);
    private void ComposerRetryClicked(object sender,RoutedEventArgs args){
        if(selectedSession is {} id&&ComposerState(id) is {Retryable:true,SubmittedText:{} text})SendComposer(text);
    }
    private async void SendComposer(string raw){
        var text=raw.Trim();
        if(text.Length==0||selectedSession is not {} id||!ComposerBox.IsEnabled||!connected)return;
        var composer=ComposerState(id);
        if(composer.Pending)return;
        if(bridge is not {} connection){ShowError("尚未连接电脑。");return;}
        if(System.Text.Encoding.UTF8.GetByteCount(text)>16*1024){ShowError("消息过长，请分成多条发送。");return;}
        var requestId=NewRequestId();var generation=chatGeneration;
        composer.Begin(requestId,text,generation);LoadDraft();
        try{
            // Sent directly rather than through Send(), which swallows failures:
            // a swallowed one would leave the composer waiting for a receipt
            // that is never coming.
            await connection.Send(new{op="chat-send",requestId,conversationId=id,generation,text});
            await Task.Delay(TimeSpan.FromSeconds(45));
            if(composer.RequestId==requestId&&composer.Pending)composer.LoseConfirmation("未收到最终回执，不会自动重发。");
        }catch(CliUnavailableException e){composer.Apply(requestId,generation,"failed",e.Message);}
        catch(Exception e){composer.Apply(requestId,generation,"uncertain",e.Message);}
        if(connection==bridge&&id==selectedSession){LoadDraft();UpdateComposer();}
    }
    /// <summary>Show whichever surface the current session and view call for.</summary>
    private void ShowSurface(){
        bool hasSession=selectedSession!=null;
        TerminalEmpty.Visibility=hasSession?Visibility.Collapsed:Visibility.Visible;
        ChatView.Visibility=hasSession&&chatMode?Visibility.Visible:Visibility.Collapsed;
        TerminalView.Visibility=hasSession&&!chatMode&&activeSession==selectedSession?Visibility.Visible:Visibility.Collapsed;
        Composer.Visibility=hasSession&&chatMode?Visibility.Visible:Visibility.Collapsed;
        ViewBar.Visibility=hasSession?Visibility.Visible:Visibility.Collapsed;
    }
    private async void NavigationChanged(NavigationView sender,NavigationViewSelectionChangedEventArgs args){
        if(!initialized||updatingNavigation)return;
        try{if(args.IsSettingsSelected){SettingsPage.Visibility=Visibility.Visible;Workspace.Visibility=Visibility.Collapsed;PageTitle.Text="设置";return;}
            if(args.SelectedItem is NavigationViewItem item){if(item.Tag is ConnectionProfile profile)await SelectProfile(profile);else if(item.Tag as string=="add")await AddProfile();}}
        catch(Exception e){ShowError(e.Message);}
    }
    private async Task AddProfile(){
        if(dialogOpen)return;dialogOpen=true;
        try{
            var name=new TextBox{Header="电脑名称（可选）",PlaceholderText="Mac mini"};var code=new TextBox{Header="配对码或链接",AcceptsReturn=true,TextWrapping=TextWrapping.Wrap,Height=100};var proxy=new TextBox{Header="HTTP 代理（可选）",PlaceholderText="留空直连"};var error=new TextBlock{TextWrapping=TextWrapping.Wrap};
            var panel=new StackPanel{Spacing=12};panel.Children.Add(name);panel.Children.Add(code);panel.Children.Add(proxy);panel.Children.Add(error);
            ConnectionProfile? result=null;
            var dialog=new ContentDialog{XamlRoot=Root.XamlRoot,RequestedTheme=Root.ActualTheme,Title="添加电脑",Content=panel,PrimaryButtonText="连接",CloseButtonText="取消",DefaultButton=ContentDialogButton.Primary};
            dialog.PrimaryButtonClick+=(_,e)=>{try{result=ConnectionProfile.Parse(code.Text,name.Text,proxy.Text.Trim());}catch(Exception ex){error.Text=ex.Message;e.Cancel=true;}};
            if(await dialog.ShowAsync()==ContentDialogResult.Primary&&result!=null){store.Add(result);PopulateProfiles();await SelectProfile(result);}
        }finally{dialogOpen=false;}
    }
    private async void AddClicked(object sender,RoutedEventArgs args){try{await AddProfile();}catch(Exception e){ShowError(e.Message);}}
    private async void NewClicked(object sender,RoutedEventArgs args){
        if(dialogOpen||bridge==null)return;dialogOpen=true;
        try{
            var agent=new ComboBox{Header="Agent",HorizontalAlignment=HorizontalAlignment.Stretch};agent.Items.Add("Terminal（普通终端）");foreach(var item in agents)agent.Items.Add(item);agent.SelectedIndex=agents.Contains("codex")?agents.IndexOf("codex")+1:0;
            var cwd=new TextBox{Header="工作目录（可选）",PlaceholderText="填写 Host 上的目录"};var panel=new StackPanel{Spacing=14};panel.Children.Add(new TextBlock{Text="创建到："+store.Active?.Name});panel.Children.Add(agent);panel.Children.Add(cwd);
            var dialog=new ContentDialog{XamlRoot=Root.XamlRoot,RequestedTheme=Root.ActualTheme,Title="新建对话",Content=panel,PrimaryButtonText="创建并打开",CloseButtonText="取消",DefaultButton=ContentDialogButton.Primary};
            if(await dialog.ShowAsync()==ContentDialogResult.Primary){creatingSession=true;try{await bridge.Send(new{op="create",agent=agent.SelectedIndex>0?agent.SelectedItem?.ToString():null,cwd=cwd.Text.Trim()});}catch{creatingSession=false;throw;}}
        }catch(Exception e){ShowError(e.Message);}finally{dialogOpen=false;QueueTerminalFocus();}
    }
    private async Task Send(object request){try{if(bridge!=null)await bridge.Send(request);}catch{ShowError("连接已中断，请重试。");}}
    private async void RefreshClicked(object sender,RoutedEventArgs args){if(!connected&&store.Active is {} profile){try{await SelectProfile(profile);}catch(Exception e){ShowError(e.Message);}}else await Send(new{op="refresh"});}
    private async void SaveProxyClicked(object sender,RoutedEventArgs args){try{if(store.Active is {} profile){ConnectionProfile.ValidateProxy(ProxyBox.Text.Trim());profile.Proxy=ProxyBox.Text.Trim();store.Save();await SelectProfile(profile);}}catch(Exception e){ShowError(e.Message);}}
    private void SessionViewChanged(object sender,SelectionChangedEventArgs args){
        if(!initialized||SessionViewPicker.SelectedItem is not ComboBoxItem{Tag:string value}||value==store.SessionView)return;
        store.SessionView=value;
        try{store.Save();}catch{ShowError("默认会话界面未能保存。");}
    }
    private async void CheckCliClicked(object sender,RoutedEventArgs args){try{CliStatus.Text=await CliBridge.Version();}catch{CliStatus.Text="不可用，请重新安装。";}}
    private void ThemeChanged(object sender,SelectionChangedEventArgs args){if(Root!=null)Root.RequestedTheme=ThemePicker.SelectedIndex switch{1=>ElementTheme.Light,2=>ElementTheme.Dark,_=>ElementTheme.Default};if(initialized){store.Theme=ThemePicker.SelectedIndex;try{store.Save();}catch{ShowError("外观设置未能保存。");}}}
    private async void ForgetClicked(object sender,RoutedEventArgs args){
        if(dialogOpen||store.Active==null)return;dialogOpen=true;
        try{var dialog=new ContentDialog{XamlRoot=Root.XamlRoot,RequestedTheme=Root.ActualTheme,Title="忘记这台电脑？",Content="将移除配对并停止本机协助，Host 上的会话保留。",PrimaryButtonText="忘记",CloseButtonText="取消"};if(await dialog.ShowAsync()!=ContentDialogResult.Primary)return;
            var id=store.ActiveProfile;computer.Stop();if(bridge!=null)await bridge.DisposeAsync();bridge=null;store.Profiles.RemoveAll(p=>p.Id==id);store.ActiveProfile=store.Profiles.FirstOrDefault()?.Id;store.Save();PopulateProfiles();if(store.Active is {} profile)await SelectProfile(profile);else{connected=false;NewButton.IsEnabled=false;AssistanceButton.IsEnabled=false;PageTitle.Text="连接你的电脑";allSessions=[];FilterSessions();ShowEmpty();}}
        finally{dialogOpen=false;}
    }
    private async Task UpdateBrowserStatus(){try{var status=await BrowserBridge.Run("status");BrowserStatus.Text=status["connected"]?.GetValue<bool>()==true?(status["enabled"]?.GetValue<bool>()==true?"已连接 · 浏览器协助已开启":"已连接 · 请在插件中开启协助"):status["installed"]?.GetValue<bool>()==true?"连接组件已安装 · 等待 Chrome 插件连接":"尚未安装 Chrome 连接组件";}catch{BrowserStatus.Text="连接组件不可用，请重新安装。";}}
    private async void InstallBrowserClicked(object sender,RoutedEventArgs e){try{await BrowserBridge.Run("install");await UpdateBrowserStatus();}catch(Exception error){ShowError(error.Message);}}
    private async void CheckBrowserClicked(object sender,RoutedEventArgs e)=>await UpdateBrowserStatus();
    private async void BrowserFolderClicked(object sender,RoutedEventArgs e){try{var result=await BrowserBridge.Run("path");var dir=result["extensionPath"]?.GetValue<string>();if(dir!=null&&Directory.Exists(dir))System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(dir){UseShellExecute=true});else BrowserStatus.Text="请先安装连接组件。";}catch{ShowError("插件目录无法打开。");}}
    private void OpenChromeExtensionsClicked(object sender,RoutedEventArgs e){try{var chrome=new[]{Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)}.Select(p=>Path.Combine(p,"Google","Chrome","Application","chrome.exe")).FirstOrDefault(File.Exists);if(chrome==null){BrowserStatus.Text="请先安装 Chrome。";return;}var start=new System.Diagnostics.ProcessStartInfo(chrome){UseShellExecute=false};start.ArgumentList.Add("chrome://extensions/");System.Diagnostics.Process.Start(start);}catch{BrowserStatus.Text="请在 Chrome 地址栏输入 chrome://extensions。";}}
    private async void AssistanceClicked(object sender,RoutedEventArgs args){if(computer.Enabled){computer.Stop();return;}AssistanceButton.IsEnabled=false;try{await computer.Enable();}catch{ShowError("电脑工具未能启动，请检查安装。你可以重新尝试。");}finally{AssistanceButton.IsEnabled=connected;UpdatePermission();}}
    private void UpdatePermission(){AssistanceTitle.Text=computer.Enabled?"正在允许本机协助":"本机协助已关闭";AssistanceDescription.Text=computer.Enabled?"Ctrl + Alt + Esc 随时停止":"允许后，Agent 可查看屏幕并操作这台 Windows 电脑。";AssistanceButton.Content=computer.Enabled?"停止协助":"允许协助";}
}
