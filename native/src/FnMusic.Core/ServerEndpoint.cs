using System.Security.Cryptography;
using System.Text;

namespace FnMusic.Core;

public sealed class ServerEndpoint
{
    public Uri Origin { get; }
    public Uri MusicUri => new(Origin, "music/");
    public Uri ApiUri => new(Origin, "music/api/v1/");
    public string StorageKey => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Origin.AbsoluteUri)));

    private ServerEndpoint(Uri origin) => Origin = origin;

    public static ServerEndpoint Parse(string input)
    {
        if (input.Length > 2048 || !Uri.TryCreate(input.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            string.IsNullOrEmpty(uri.Host) || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0 ||
            (uri.AbsolutePath != "/" && uri.AbsolutePath != "/music" && uri.AbsolutePath != "/music/"))
            throw new ArgumentException("请输入 HTTP 或 HTTPS 服务器地址，可带 /music/ 路径；不能包含账号、查询参数或片段。");
        return new ServerEndpoint(new Uri(uri.GetLeftPart(UriPartial.Authority) + "/"));
    }
}
