using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FnMusic.Core;
using FnMusic.Infrastructure;
using FnMusic.Windows;

int passed = 0;
void Check(bool value) { if (!value) throw new Exception("Assertion failed"); }
async Task Test(string name, Func<Task> run) { await run(); passed++; Console.WriteLine("PASS " + name); }
async Task Fails(MusicFailure failure, Func<Task> run)
{
    try { await run(); throw new Exception("Expected API failure"); }
    catch (MusicApiException ex) { Check(ex.Failure == failure); }
}
var endpoint = ServerEndpoint.Parse("https://nas.example.invalid/music/");
await Test("canonical origin and connection identity", () =>
{
    Check(endpoint.StorageKey == ServerEndpoint.Parse("https://NAS.example.invalid:443").StorageKey);
    Check(endpoint.StorageKey != ServerEndpoint.Parse("http://nas.example.invalid").StorageKey);
    Check(endpoint.ApiUri.AbsolutePath == "/music/api/v1/");
    return Task.CompletedTask;
});
await Test("reject credentials, query, fragments and unrelated paths", () =>
{
    foreach (var input in new[] { "file:///music", "https://user@nas.example.invalid", "https://nas.example.invalid/?code=test", "https://nas.example.invalid/#fragment", "https://nas.example.invalid/admin" })
    {
        try { ServerEndpoint.Parse(input); throw new Exception("Accepted invalid endpoint"); }
        catch (ArgumentException) { }
    }
    return Task.CompletedTask;
});
await Test("connection probe parses initialization status", async () =>
{
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => Json("{\"code\":0,\"data\":{\"initialized\":true}}")));
    Check(await api.CheckConnectionAsync(default));
});
await Test("redirect response is rejected without another request", async () =>
{
    int calls = 0;
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => { calls++; var response = new HttpResponseMessage(HttpStatusCode.Redirect); response.Headers.Location = new Uri("https://other.example.invalid"); return response; }));
    await Fails(MusicFailure.RedirectRejected, () => api.GetCurrentUserAsync(default));
    Check(calls == 1);
});
await Test("401 clears the in-memory session", async () =>
{
    int calls = 0;
    using var api = new NasApiClient(endpoint, new FakeHandler(request =>
    {
        Check(request.Headers.Contains("Cookie") == (calls == 0));
        calls++;
        return new HttpResponseMessage(HttpStatusCode.Unauthorized);
    }));
    api.RestoreSession(new string('x', 32));
    await Fails(MusicFailure.Unauthorized, () => api.GetCurrentUserAsync(default));
    await Fails(MusicFailure.Unauthorized, () => api.GetCurrentUserAsync(default));
});
await Test("unexpected JSON types remain sanitized API failures", async () =>
{
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => Json("{\"code\":{},\"msg\":\"private response\"}")));
    await Fails(MusicFailure.InvalidResponse, () => api.GetCurrentUserAsync(default));
});
await Test("oversized responses are bounded", async () =>
{
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => Json(new string('x', 2 * 1024 * 1024 + 1))));
    await Fails(MusicFailure.InvalidResponse, () => api.GetCurrentUserAsync(default));
});
await Test("login hashes password and only subsequent requests carry the session", async () =>
{
    int calls = 0;
    string password = new('p', 12);
    string session = new('s', 32);
    using var api = new NasApiClient(endpoint, new FakeHandler(request =>
    {
        Check(request.RequestUri!.Origin() == endpoint.Origin.AbsoluteUri);
        if (calls++ == 0)
        {
            Check(!request.Headers.Contains("Cookie"));
            using var body = JsonDocument.Parse(request.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            Check(body.RootElement.GetProperty("password").GetString() == Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(password))));
            return Json(JsonSerializer.Serialize(new { code = 0, data = new { userToken = session, user = new { name = "测试账户" } } }));
        }
        Check(request.Headers.GetValues("Cookie").Single() == "music-token=" + session);
        return Json("{\"code\":0,\"data\":{\"name\":\"测试账户\"}}");
    }));
    await api.LoginAsync("account", password, new string('a', 32), default);
    Check((await api.GetCurrentUserAsync(default)).Name == "测试账户");
});
await Test("invalid session data cannot inject request headers", () =>
{
    using var api = new NasApiClient(endpoint);
    try { api.RestoreSession("value\r\nInjected: value"); throw new Exception("Accepted injection"); }
    catch (MusicApiException) { }
    return Task.CompletedTask;
});
if (args.Length < 1) throw new Exception("Provide a dedicated test data directory");
string testDirectory = Path.Combine(Path.GetFullPath(args[0]), Guid.NewGuid().ToString("N"));
await Test("first login can clear a session before its directory exists", async () =>
{
    var vault = new DpapiSessionVault(Path.Combine(testDirectory, "not-created"));
    await vault.ClearAsync(endpoint.StorageKey, default);
    await vault.ClearAsync(endpoint.StorageKey, default);
    Check(await vault.LoadAsync(endpoint.StorageKey, default) is null);
});
if (args.Contains("--skip-dpapi")) Console.WriteLine("SKIP DPAPI: explicitly excluded for the sandbox user; requires normal Windows profile.");
else await Test("DPAPI stores encrypted data and restores only for the matching connection", async () =>
{
    var vault = new DpapiSessionVault(testDirectory);
    string session = new('q', 32);
    await vault.SaveAsync(endpoint.StorageKey, session, default);
    Check(await vault.LoadAsync(endpoint.StorageKey, default) == session);
    var file = Path.Combine(testDirectory, endpoint.StorageKey + ".bin");
    Check(!Encoding.UTF8.GetString(await File.ReadAllBytesAsync(file)).Contains(session));
    string other = ServerEndpoint.Parse("https://other.example.invalid").StorageKey;
    File.Copy(file, Path.Combine(testDirectory, other + ".bin"));
    try { await vault.LoadAsync(other, default); throw new Exception("Origin binding failed"); }
    catch (CryptographicException) { }
    await vault.ClearAsync(endpoint.StorageKey, default);
    await vault.ClearAsync(other, default);
    Check(await vault.LoadAsync(endpoint.StorageKey, default) is null);
});
await Test("connection settings survive UTF-8 round trip", async () =>
{
    var store = new ConnectionSettingsStore(testDirectory);
    var settings = new ConnectionSettings(endpoint.MusicUri.AbsoluteUri, new string('a', 32), true);
    await store.SaveAsync(settings, default);
    Check(await store.LoadAsync(default) == settings);
});
await Test("track page maps milliseconds and artists", async () =>
{
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"total":1,"list":[{"guid":"test-track","title":"测试","artists":[{"name":"甲"},{"name":"乙"}],"duration":125000,"isCue":true}]}}""")));
    var result = await api.ListTracksAsync(1, 50, default);
    Check(result.Total == 1 && result.Tracks[0].DurationSeconds == 125);
    Check(result.Tracks[0].Artist == "甲 / 乙" && result.Tracks[0].DisplayDuration == "2:05" && result.Tracks[0].IsCue);
});
await Test("track page rejects malformed total without exposing response", async () =>
{
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"total":"private","list":[]}}""")));
    await Fails(MusicFailure.InvalidResponse, () => api.ListTracksAsync(1, 50, default));
});
await Test("range stream seeks across cache blocks and reaches EOF", async () =>
{
    byte[] song = Enumerable.Range(0, 600000).Select(i => (byte)(i % 251)).ToArray();
    int calls = 0;
    var handler = new FakeHandler(request =>
    {
        calls++;
        var range = request.Headers.Range!.Ranges.Single();
        long from = range.From!.Value, to = range.To!.Value;
        var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(song[(int)from..((int)to + 1)]) };
        response.Content.Headers.ContentRange = new System.Net.Http.Headers.ContentRangeHeaderValue(from, to, song.Length);
        response.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("audio/flac");
        return response;
    });
    using var stream = await HttpRangeStream.OpenAsync(new HttpClient(handler), endpoint.MusicUri, default);
    byte[] actual = new byte[1024];
    Check(await stream.ReadAsync(actual) == actual.Length && actual.SequenceEqual(song[..1024]));
    stream.Seek(4096, SeekOrigin.Begin);
    Check(await stream.ReadAsync(actual) == actual.Length && actual.SequenceEqual(song[4096..5120]) && calls == 2);
    stream.Seek(300000, SeekOrigin.Begin);
    Check(await stream.ReadAsync(actual) == actual.Length && actual.SequenceEqual(song[300000..301024]) && calls == 3);
    stream.Seek(-10, SeekOrigin.End);
    Check(await stream.ReadAsync(actual) == 10 && actual[..10].SequenceEqual(song[^10..]));
    Check(await stream.ReadAsync(actual) == 0);
    stream.Dispose();
    try { _ = await stream.ReadAsync(actual); throw new Exception("Disposed stream accepted read"); }
    catch (ObjectDisposedException) { }
});
await Test("range stream rejects redirects and servers ignoring Range", async () =>
{
    foreach (var status in new[] { HttpStatusCode.Redirect, HttpStatusCode.OK, HttpStatusCode.Unauthorized })
    {
        var failure = status == HttpStatusCode.Redirect ? MusicFailure.RedirectRejected : status == HttpStatusCode.Unauthorized ? MusicFailure.Unauthorized : MusicFailure.InvalidResponse;
        await Fails(failure, async () => { using var stream = await HttpRangeStream.OpenAsync(new HttpClient(new FakeHandler(_ => new HttpResponseMessage(status))), endpoint.MusicUri, default); });
    }
});
await Test("range stream rejects a file changing size between requests", async () =>
{
    int calls = 0;
    var handler = new FakeHandler(request =>
    {
        var range = request.Headers.Range!.Ranges.Single();
        var response = new HttpResponseMessage(HttpStatusCode.PartialContent) { Content = new ByteArrayContent(new byte[100]) };
        response.Content.Headers.ContentRange = new System.Net.Http.Headers.ContentRangeHeaderValue(range.From!.Value, range.To!.Value, calls++ == 0 ? 100 : 101);
        return response;
    });
    using var stream = await HttpRangeStream.OpenAsync(new HttpClient(handler), endpoint.MusicUri, default);
    await Fails(MusicFailure.InvalidResponse, async () => { _ = await stream.ReadAsync(new byte[10]); });
});
if (args.Contains("--ffmpeg"))
{
    foreach (string format in new[] { "wav", "flac", "mp3", "ogg" })
    {
        await Test("FFmpeg decodes synthetic " + format + " and seeks by decoded timestamp", async () =>
        {
            // 全部测试音频由本机生成，不接触用户歌曲或网络。
            var info = new System.Diagnostics.ProcessStartInfo(FfmpegPcmDecoder.FindExecutable())
            { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            foreach (string arg in new[] { "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", format, "pipe:1" }) info.ArgumentList.Add(arg);
            using var encoder = System.Diagnostics.Process.Start(info)!;
            using var encoded = new MemoryStream();
            var errors = encoder.StandardError.ReadToEndAsync();
            await encoder.StandardOutput.BaseStream.CopyToAsync(encoded);
            await encoder.WaitForExitAsync(); await errors;
            Check(encoder.ExitCode == 0 && encoded.Length > 0);
            foreach (int start in new[] { 0, 1 })
            {
                encoded.Position = 0;
                await using var decoder = new FfmpegPcmDecoder(encoded, TimeSpan.FromSeconds(start));
                using var pcm = new MemoryStream();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                await decoder.Output.CopyToAsync(pcm, timeout.Token);
                await decoder.CheckCompletionAsync(timeout.Token);
                double seconds = (double)pcm.Length / FfmpegPcmDecoder.BytesPerSecond;
                Check(Math.Abs(seconds - (2 - start)) < 0.15);
                Check(pcm.ToArray().Any(b => b != 0));
            }
        });
    }
    await Test("FFmpeg rejects malformed input with sanitized failure", async () =>
    {
        using var invalid = new MemoryStream(Encoding.UTF8.GetBytes("not music"));
        await using var decoder = new FfmpegPcmDecoder(invalid, TimeSpan.Zero);
        await decoder.Output.CopyToAsync(Stream.Null);
        try { await decoder.CheckCompletionAsync(default); throw new Exception("Invalid audio accepted"); }
        catch (IOException error) { Check(error.Message == "Audio decoding failed."); }
    });
    await Test("FFmpeg stops when PCM output is not consumed and cleanup is repeatable", async () =>
    {
        using var wave = new MemoryStream();
        using (var writer = new BinaryWriter(wave, Encoding.UTF8, leaveOpen: true))
        {
            const int dataSize = 48000 * 4 * 20;
            writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(dataSize + 36);
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
            writer.Write((short)1); writer.Write((short)2); writer.Write(48000);
            writer.Write(192000); writer.Write((short)4); writer.Write((short)16);
            writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(dataSize); writer.Write(new byte[dataSize]);
        }
        wave.Position = 0;
        var decoder = new FfmpegPcmDecoder(wave, TimeSpan.Zero);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await decoder.Output.ReadExactlyAsync(new byte[16], timeout.Token);
            await decoder.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            await decoder.DisposeAsync();
            Check(wave.CanRead); // 解码器不拥有输入，播放源在清理结束后释放它。
        }
        finally { await decoder.DisposeAsync(); }
    });
}
MusicTrack MakeTrack(string id, bool cue = false) => new(id, "测试曲目", "测试歌手", 60, cue);
await Test("queue snapshot excludes unsupported tracks and survives source mutation", () =>
{
    var source = new List<MusicTrack> { MakeTrack("a"), MakeTrack("cue", true), MakeTrack("b"), MakeTrack("a") };
    var queue = new PlaybackQueue();
    Check(queue.Replace(source, "a") && queue.Count == 2);
    source.Clear();
    Check(queue.Next(true)?.Id == "b" && queue.Next(true) is null);
    Check(queue.Previous()?.Id == "a");
    return Task.CompletedTask;
});
await Test("queue distinguishes automatic repeat-one from manual next", () =>
{
    var queue = new PlaybackQueue { Mode = QueueMode.RepeatOne };
    queue.Replace(new[] { MakeTrack("a"), MakeTrack("b") }, "a");
    Check(queue.Next(true)?.Id == "a");
    Check(queue.Next(false)?.Id == "b" && queue.Next(false)?.Id == "a");
    queue.Mode = QueueMode.RepeatAll;
    Check(queue.Previous()?.Id == "b");
    return Task.CompletedTask;
});
await Test("shuffle avoids immediate repeats and previous restores playback history", () =>
{
    var queue = new PlaybackQueue(new Random(42)) { Mode = QueueMode.Shuffle };
    queue.Replace(new[] { MakeTrack("a"), MakeTrack("b"), MakeTrack("c") }, "a");
    for (int i = 0; i < 20; i++)
    {
        string before = queue.Current!.Id;
        Check(queue.Next(true)?.Id != before);
        Check(queue.Previous()?.Id == before);
    }
    return Task.CompletedTask;
});
await Test("queue clear prevents cross-account continuation", () =>
{
    var queue = new PlaybackQueue();
    queue.Replace(new[] { MakeTrack("a") }, "a"); queue.Clear();
    Check(queue.Current is null && queue.Count == 0 && queue.Next(true) is null && queue.Previous() is null);
    return Task.CompletedTask;
});
await Test("queue removal preserves identity and discards stale shuffle history", () =>
{
    var queue = new PlaybackQueue(new Random(42)) { Mode = QueueMode.Shuffle };
    queue.Replace(new[] { MakeTrack("a"), MakeTrack("b"), MakeTrack("c") }, "b");
    Check(queue.Select("c")?.Id == "c");
    Check(queue.Remove("a") && queue.Current?.Id == "c" && queue.Index == 1);
    Check(queue.Previous()?.Id == "b");
    Check(!queue.Remove("missing") && queue.Count == 2);
    Check(queue.Select("missing") is null && queue.Current?.Id == "b");
    Check(queue.Remove("b") && queue.Current is null && queue.Next(true) is null);
    Check(queue.Select("c")?.Id == "c");
    Check(queue.Remove("c") && queue.Count == 0 && queue.Previous() is null);
    return Task.CompletedTask;
});
await Test("invalid queue replacement preserves the active snapshot", () =>
{
    var queue = new PlaybackQueue();
    queue.Replace(new[] { MakeTrack("a") }, "a");
    Check(!queue.Replace(new[] { MakeTrack("cue", true) }, "cue") && queue.Current?.Id == "a");
    queue.Mode = QueueMode.Shuffle;
    Check(queue.Next(true) is null);
    return Task.CompletedTask;
});
Console.WriteLine($"Native checks: {passed} passed.");
return;

static HttpResponseMessage Json(string content) => new(HttpStatusCode.OK) { Content = new StringContent(content, Encoding.UTF8, "application/json") };
sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> response) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => Task.FromResult(response(request));
}
static class UriExtensions
{
    public static string Origin(this Uri uri) => uri.GetLeftPart(UriPartial.Authority) + "/";
}
