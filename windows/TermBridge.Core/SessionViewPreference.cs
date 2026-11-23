namespace TermBridge.Core;

/// The local default for the next opened session; a reconnect retains its view.
public static class SessionViewPreference {
    public const string Auto = "auto";
    public const string Chat = "chat";
    public const string Terminal = "terminal";
    public static string Normalize(string? value) => value is Chat or Terminal ? value : Auto;
    public static bool UsesChat(string? preference, bool available, bool? currentView = null) =>
        available && (currentView ?? Normalize(preference) != Terminal);
}
