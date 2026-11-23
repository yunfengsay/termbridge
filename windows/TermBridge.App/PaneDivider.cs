using Microsoft.UI.Input;
using Microsoft.UI.Xaml.Controls;
namespace TermBridge.App;
public sealed class PaneDivider : UserControl {
    public PaneDivider(){ProtectedCursor=InputSystemCursor.Create(InputSystemCursorShape.SizeWestEast);}
}
