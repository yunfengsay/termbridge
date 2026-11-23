using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TermBridge.Core;

public sealed record ConnectionProfile {
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = "我的电脑";
    public string RelayUrl { get; set; } = "";
    public string HostId { get; set; } = "";
    public string Secret { get; set; } = ""; // DPAPI ciphertext, including in memory models.
    public string Pin { get; set; } = "";
    public string Proxy { get; set; } = "";
    public override string ToString() => Name;
    public string RevealSecret() => Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(Secret),null,DataProtectionScope.CurrentUser));
    public static ConnectionProfile Parse(string text, string name, string proxy, string? hostedRelay = null) {
        text=text.Trim(); string secret, relay, host="", pin="";
        if(System.Text.RegularExpressions.Regex.IsMatch(text,@"^tb1_[A-Za-z0-9_-]{43}$")) {
            var baseRelay=(hostedRelay??Environment.GetEnvironmentVariable("TB_CLOUDFLARE_RELAY")??"").Trim().TrimEnd('/');
            if(string.IsNullOrEmpty(baseRelay))throw new ArgumentException("短配对码需要配置 TB_CLOUDFLARE_RELAY；请改用自建中继生成的完整 termbridge://pair 配对链接。");
            secret=text[4..];relay=baseRelay+"/r/"+Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(secret)));
        } else {
            if(!Uri.TryCreate(text,UriKind.Absolute,out var uri)||uri.Scheme!="termbridge"||uri.Host!="pair")throw new ArgumentException("请粘贴 TB 配对码或配对链接。");
            var values=uri.Query.TrimStart('?').Split('&',StringSplitOptions.RemoveEmptyEntries).Select(p=>p.Split('=',2)).ToDictionary(p=>p[0],p=>p.Length>1?Uri.UnescapeDataString(p[1].Replace("+"," ")):"");
            string Get(string key)=>values.GetValueOrDefault(key,"");
            if(Get("v")!="1")throw new ArgumentException("不支持的配对版本。");
            relay=Get("relay");secret=Get("secret");host=Get("host");pin=Get("pin").Replace(":","").ToLowerInvariant();
            if(string.IsNullOrWhiteSpace(name))name=Get("name");
        }
        if(!Uri.TryCreate(relay,UriKind.Absolute,out var target)||target.Scheme!="wss"||target.UserInfo!=""||target.Fragment!="")throw new ArgumentException("配对需要安全的 WSS 地址。");
        if(secret.Length is <16 or >256)throw new ArgumentException("配对密钥长度无效。");
        if(host.Length>128||(host.Length>0&&!System.Text.RegularExpressions.Regex.IsMatch(host,@"^[A-Za-z0-9._:-]+$")))throw new ArgumentException("Host 标识无效。");
        if(pin.Length>0&&!System.Text.RegularExpressions.Regex.IsMatch(pin,@"^[a-f0-9]{64}$"))throw new ArgumentException("证书指纹无效。");
        ValidateProxy(proxy);
        return new(){Name=string.IsNullOrWhiteSpace(name)?"我的电脑":name.Trim(),RelayUrl=relay,HostId=host,Pin=pin,Proxy=proxy,
            Secret=Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(secret),null,DataProtectionScope.CurrentUser))};
    }
    public static void ValidateProxy(string value) {
        if(value.Length>0&&(!Uri.TryCreate(value,UriKind.Absolute,out var uri)||uri.Scheme is not ("http" or "https")||uri.UserInfo!=""))throw new ArgumentException("请输入不含密码的 HTTP 代理地址。");
    }
}
public sealed class ConnectionStore {
    public List<ConnectionProfile> Profiles { get; set; } = [];
    public string? ActiveProfile { get; set; }
    public int Theme { get; set; }
    private string sessionView = SessionViewPreference.Auto;
    public string SessionView { get => sessionView; set => sessionView = SessionViewPreference.Normalize(value); }
    public double SessionListWidth { get; set; } = 216;
    public ConnectionProfile? Active => Profiles.FirstOrDefault(p=>p.Id==ActiveProfile);
    public static string DirectoryPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),"TermBridge");
    public static string StorePath => Path.Combine(DirectoryPath,"connections.json");
    public static readonly JsonSerializerOptions Json = new(){PropertyNamingPolicy=JsonNamingPolicy.CamelCase,PropertyNameCaseInsensitive=true,WriteIndented=true,IgnoreReadOnlyProperties=true};
    public static ConnectionStore Load() => File.Exists(StorePath)?JsonSerializer.Deserialize<ConnectionStore>(File.ReadAllText(StorePath),Json)??new():new();
    public void Save(){Directory.CreateDirectory(DirectoryPath);var temp=StorePath+".tmp";File.WriteAllText(temp,JsonSerializer.Serialize(this,Json));File.Move(temp,StorePath,true);}
    public void Add(ConnectionProfile profile){var existing=Profiles.FindIndex(p=>p.RelayUrl==profile.RelayUrl&&p.HostId==profile.HostId);if(existing>=0){profile.Id=Profiles[existing].Id;Profiles[existing]=profile;}else Profiles.Add(profile);ActiveProfile=profile.Id;Save();}
}
