using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FnMusic.Core;

namespace FnMusic.Infrastructure;

public sealed class NasApiClient : IDisposable
{
    private readonly HttpClient http;
    private readonly ServerEndpoint endpoint;
    private string? token;
    public NasApiClient(ServerEndpoint endpoint, HttpMessageHandler? handler = null)
    {
        this.endpoint = endpoint;
        http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(15) };
    }

    public void RestoreSession(string sessionToken)
    {
        if (string.IsNullOrWhiteSpace(sessionToken) || sessionToken.Length > 16384 ||
            sessionToken.Any(c => c < 33 || c > 126 || c is ';' or ','))
            throw new MusicApiException(MusicFailure.InvalidResponse);
        token = sessionToken;
    }
    public void ClearSession() => token = null;

    public async Task<TrackPage> ListTracksAsync(int page, int size, CancellationToken ct)
    {
        if (page < 1 || size is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(page));
        using var data = await RequestAsync(HttpMethod.Get, $"track/list?page={page}&size={size}", null, ct);
        var root = data.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("list", out var list) || list.ValueKind != JsonValueKind.Array ||
            !root.TryGetProperty("total", out var total) || total.ValueKind != JsonValueKind.Number || !total.TryGetInt32(out int count) || count < 0)
            throw new MusicApiException(MusicFailure.InvalidResponse);
        List<MusicTrack> tracks = [];
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("guid", out var id) || id.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(id.GetString()))
                throw new MusicApiException(MusicFailure.InvalidResponse);
            string title = item.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()! : "未命名曲目";
            string artist = item.TryGetProperty("artists", out var artists) && artists.ValueKind == JsonValueKind.Array
                ? string.Join(" / ", artists.EnumerateArray().Where(a => a.ValueKind == JsonValueKind.Object && a.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String).Select(a => a.GetProperty("name").GetString())) : "";
            double duration = item.TryGetProperty("duration", out var d) && d.ValueKind == JsonValueKind.Number && d.TryGetDouble(out double ms) && double.IsFinite(ms) ? Math.Max(0, ms / 1000) : 0;
            bool cue = item.TryGetProperty("isCue", out var c) && c.ValueKind == JsonValueKind.True;
            tracks.Add(new MusicTrack(id.GetString()!, title, artist, duration, cue));
        }
        return new TrackPage(tracks, count);
    }

    public async Task<HttpRangeStream> OpenTrackStreamAsync(string id, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(id) || id.Length > 256) throw new ArgumentException("Invalid track identifier");
        if (token is null) throw new MusicApiException(MusicFailure.Unauthorized);
        var transport = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(15) };
        transport.DefaultRequestHeaders.Add("Cookie", "music-token=" + Uri.EscapeDataString(token));
        return await HttpRangeStream.OpenAsync(transport, new Uri(endpoint.ApiUri, "track/stream?guid=" + Uri.EscapeDataString(id)), ct).ConfigureAwait(false);
    }

    public async Task<bool> CheckConnectionAsync(CancellationToken ct)
    {
        using var data = await RequestAsync(HttpMethod.Get, "initialization/state", null, ct);
        if (!data.RootElement.TryGetProperty("initialized", out var state) || state.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new MusicApiException(MusicFailure.InvalidResponse);
        return state.GetBoolean();
    }
    public async Task<MusicUser> GetCurrentUserAsync(CancellationToken ct)
    {
        using var data = await RequestAsync(HttpMethod.Get, "user/me", null, ct);
        return ParseUser(data.RootElement);
    }
    public async Task<string> LoginAsync(string username, string password, string deviceId, CancellationToken ct)
    {
        ClearSession();
        byte[] passwordBytes = Encoding.UTF8.GetBytes(password);
        string digest;
        try { digest = Convert.ToHexStringLower(SHA256.HashData(passwordBytes)); }
        finally { CryptographicOperations.ZeroMemory(passwordBytes); }
        using var data = await RequestAsync(HttpMethod.Post, "user/password-login",
            new { username = username.Trim(), password = digest, deviceId }, ct);
        if (!data.RootElement.TryGetProperty("userToken", out var value) || value.ValueKind != JsonValueKind.String)
            throw new MusicApiException(MusicFailure.InvalidResponse);
        if (!data.RootElement.TryGetProperty("user", out var user)) throw new MusicApiException(MusicFailure.InvalidResponse);
        _ = ParseUser(user);
        RestoreSession(value.GetString()!);
        return token!;
    }
    public async Task LogoutAsync(CancellationToken ct)
    {
        try { using var data = await RequestAsync(HttpMethod.Post, "user/logout", null, ct); }
        finally { ClearSession(); }
    }
    private static MusicUser ParseUser(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String)
            throw new MusicApiException(MusicFailure.InvalidResponse);
        return new MusicUser(name.GetString()!);
    }
    private async Task<JsonDocument> RequestAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, new Uri(endpoint.ApiUri, path));
        if (token is not null) request.Headers.Add("Cookie", "music-token=" + Uri.EscapeDataString(token));
        request.Headers.Accept.ParseAdd("application/json");
        if (body is not null) request.Content = JsonContent.Create(body);
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            if ((int)response.StatusCode is >= 300 and < 400) throw new MusicApiException(MusicFailure.RedirectRejected);
            if (response.StatusCode == HttpStatusCode.Unauthorized) { ClearSession(); throw new MusicApiException(MusicFailure.Unauthorized); }
            if (!response.IsSuccessStatusCode) throw new MusicApiException(MusicFailure.Rejected);
            // 即使 Content-Length 缺失也限制读取量，防止异常响应耗尽内存。
            using var input = await response.Content.ReadAsStreamAsync(ct);
            using var output = new MemoryStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = await input.ReadAsync(buffer, ct)) != 0)
            {
                if (output.Length + count > 2 * 1024 * 1024) throw new MusicApiException(MusicFailure.InvalidResponse);
                await output.WriteAsync(buffer.AsMemory(0, count), ct);
            }
            using var envelope = JsonDocument.Parse(output.ToArray());
            var root = envelope.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.Number || !code.TryGetInt32(out int codeValue))
                throw new MusicApiException(MusicFailure.InvalidResponse);
            if (codeValue == 120001) { ClearSession(); throw new MusicApiException(MusicFailure.Unauthorized); }
            if (codeValue is not (0 or 200)) throw new MusicApiException(MusicFailure.Rejected);
            return JsonDocument.Parse(root.TryGetProperty("data", out var data) ? data.GetRawText() : "null");
        }
        catch (JsonException) { throw new MusicApiException(MusicFailure.InvalidResponse); }
        catch (HttpRequestException) { throw new MusicApiException(MusicFailure.Unavailable); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new MusicApiException(MusicFailure.Unavailable); }
    }
    public void Dispose() { ClearSession(); http.Dispose(); }
}
