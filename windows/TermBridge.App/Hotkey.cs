using System.Runtime.InteropServices;
namespace TermBridge.App;
internal sealed class Hotkey : IDisposable {
    private readonly nint window;private readonly Subclass callback;
    private const int Id=0x5442;
    public Hotkey(nint hwnd,Action stop){window=hwnd;callback=(h,m,w,l,id,data)=>{if(m==0x312&&w==Id){stop();return 0;}return DefSubclassProc(h,m,w,l);};if(!SetWindowSubclass(hwnd,callback,Id,0)||!RegisterHotKey(hwnd,Id,0x4003,0x1B))throw new InvalidOperationException("停止快捷键注册失败，请关闭占用 Ctrl+Alt+Esc 的程序后重开 App。");}
    public void Dispose(){UnregisterHotKey(window,Id);RemoveWindowSubclass(window,callback,Id);}
    private delegate nint Subclass(nint hwnd,uint msg,nuint wparam,nint lparam,nuint id,nuint data);
    [DllImport("comctl32.dll")]private static extern bool SetWindowSubclass(nint hwnd,Subclass callback,nuint id,nuint data);
    [DllImport("comctl32.dll")]private static extern bool RemoveWindowSubclass(nint hwnd,Subclass callback,nuint id);
    [DllImport("comctl32.dll")]private static extern nint DefSubclassProc(nint hwnd,uint msg,nuint wparam,nint lparam);
    [DllImport("user32.dll")]private static extern bool RegisterHotKey(nint hwnd,int id,uint modifiers,uint key);
    [DllImport("user32.dll")]private static extern bool UnregisterHotKey(nint hwnd,int id);
}
