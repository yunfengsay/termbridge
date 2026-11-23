using Microsoft.UI.Xaml;
using System.Runtime.InteropServices;
namespace TermBridge.App;
public partial class App : Application {
    private Window? window;
    public App(){UnhandledException+=(_,e)=>Record(e.Exception);InitializeComponent();}
    protected override void OnLaunched(LaunchActivatedEventArgs args){
        try{window=new MainWindow();window.Activate();File.Delete(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"TermBridge","startup-error.log"));}
        catch(Exception e){Record(e);MessageBox(0,"TermBridge 启动失败，请重新安装或查看本机启动诊断。","TermBridge",0x10);Exit();}
    }
    private static void Record(Exception e){try{var path=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"TermBridge");Directory.CreateDirectory(path);File.WriteAllText(Path.Combine(path,"startup-error.log"),e.ToString());}catch{}}
    [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="MessageBoxW")]private static extern int MessageBox(nint hwnd,string text,string title,uint type);
}
