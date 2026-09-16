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
await Test("late unauthorized responses cannot invalidate a replaced session", async () =>
{
    foreach (bool businessError in new[] { false, true })
    {
        var response = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        int calls = 0;
        using var api = new NasApiClient(endpoint, new AsyncFakeHandler(request =>
        {
            if (++calls == 1) return response.Task;
            Check(request.Headers.GetValues("Cookie").Single() == "music-token=new-session");
            return Task.FromResult(Json("""{"code":0,"data":{"name":"测试账户"}}"""));
        }));
        api.RestoreSession("old-session");
        var pending = api.GetCurrentUserAsync(default);
        api.RestoreSession("new-session");
        response.SetResult(businessError ? Json("""{"code":120001}""") : new HttpResponseMessage(HttpStatusCode.Unauthorized));
        await Fails(MusicFailure.Unavailable, () => pending);
        Check((await api.GetCurrentUserAsync(default)).Name == "测试账户");
    }
});
await Test("network failure preserves authentication for collection retry", async () =>
{
    int calls = 0;
    using var api = new NasApiClient(endpoint, new FakeHandler(request =>
    {
        Check(request.Headers.GetValues("Cookie").Single() == "music-token=test-session");
        if (++calls == 1) throw new HttpRequestException("synthetic failure");
        return Json("""{"code":0,"data":{"list":[],"total":0}}""");
    }));
    api.RestoreSession("test-session");
    await Fails(MusicFailure.Unavailable, () => api.ListCollectionsAsync(CollectionKind.Album, 1, 50, default));
    Check((await api.ListCollectionsAsync(CollectionKind.Album, 1, 50, default)).Total == 0 && calls == 2);
});
await Test("collection lists preserve totals and optional counts", async () =>
{
    foreach (var kind in new[] { CollectionKind.Album, CollectionKind.Artist })
    {
        using var api = new NasApiClient(endpoint, new FakeHandler(request =>
        {
            Check(request.Method == HttpMethod.Get);
            Check(request.RequestUri!.AbsolutePath.EndsWith(kind == CollectionKind.Album ? "/album/list" : "/artist/list"));
            Check(request.RequestUri.Query == "?page=2&size=1");
            return Json("""{"code":0,"data":{"list":[{"guid":"collection-a","name":"测试集合"}],"total":3}}""");
        }));
        var result = await api.ListCollectionsAsync(kind, 2, 1, default);
        Check(result.Total == 3 && result.Items.Single().TrackCount is null);
    }
});
await Test("collection detail supports observed envelopes and encodes identifiers", async () =>
{
    foreach (var kind in new[] { CollectionKind.Album, CollectionKind.Artist })
    foreach (bool wrapped in new[] { false, true })
    {
        if (wrapped && kind == CollectionKind.Artist) continue;
        using var api = new NasApiClient(endpoint, new FakeHandler(request =>
        {
            Check(request.RequestUri!.Query == "?guid=a%26b");
            var item = new { guid = "a&b", name = "测试集合", trackCount = 4 };
            return Json(JsonSerializer.Serialize(new { code = 0, data = wrapped ? (object)new { album = item } : item }));
        }));
        var result = await api.GetCollectionAsync(kind, "a&b", default);
        Check(result.Name == "测试集合" && result.TrackCount == 4);
    }
});
await Test("collection tracks use scoped paginated routes and album ordering", async () =>
{
    foreach (var kind in new[] { CollectionKind.Album, CollectionKind.Artist })
    {
        string path = kind == CollectionKind.Album ? "album" : "artist";
        using var api = new NasApiClient(endpoint, new FakeHandler(request =>
        {
            Check(request.RequestUri!.AbsolutePath.EndsWith($"/track/{path}-detail/list"));
            Check(request.RequestUri.Query == $"?{path}GUID=a%26b&page=2&size=1" + (kind == CollectionKind.Album ? "&sort=trackNo%2Casc" : ""));
            return Json("""{"code":0,"data":{"list":[{"guid":"track-a","title":"测试歌曲","duration":61000}],"total":3}}""");
        }));
        var result = await api.ListCollectionTracksAsync(kind, "a&b", 2, 1, default);
        Check(result.Total == 3 && result.Tracks.Single().DurationSeconds == 61);
    }
});
await Test("collection malformed responses and mismatched detail are rejected", async () =>
{
    foreach (var data in new[] { "null", "{}", "{\"list\":[],\"total\":\"0\"}", "{\"list\":[{\"guid\":\"a\",\"name\":\"A\",\"trackCount\":-1}],\"total\":1}", "{\"list\":[{\"guid\":\"a\",\"name\":\"A\"}],\"total\":0}" })
    {
        using var api = new NasApiClient(endpoint, new FakeHandler(_ => Json("{\"code\":0,\"data\":" + data + "}")));
        await Fails(MusicFailure.InvalidResponse, () => api.ListCollectionsAsync(CollectionKind.Album, 1, 1, default));
    }
    using var mismatch = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"guid":"other","name":"A"}}""")));
    await Fails(MusicFailure.InvalidResponse, () => mismatch.GetCollectionAsync(CollectionKind.Artist, "requested", default));
});
await Test("invalid collection arguments send no request and empty lists are valid", async () =>
{
    int calls = 0;
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => { calls++; return Json("""{"code":0,"data":{"list":[],"total":0}}"""); }));
    foreach (var action in new Func<Task>[] {
        () => api.ListCollectionsAsync((CollectionKind)99, 1, 1, default),
        () => api.ListCollectionsAsync(CollectionKind.Album, 0, 1, default),
        () => api.ListCollectionTracksAsync(CollectionKind.Artist, "a", 1, 101, default),
        () => api.GetCollectionAsync(CollectionKind.Album, " ", default) })
    {
        try { await action(); throw new Exception("Accepted invalid argument"); } catch (ArgumentException) { }
    }
    Check(calls == 0);
    Check((await api.ListCollectionsAsync(CollectionKind.Artist, 1, 50, default)).Items.Count == 0);
    Check((await api.ListCollectionTracksAsync(CollectionKind.Album, "a", 1, 50, default)).Tracks.Count == 0);
});
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
await Test("search encodes query and preserves pagination and track mapping", async () =>
{
    using var api = new NasApiClient(endpoint, new FakeHandler(request =>
    {
        Check(request.RequestUri!.AbsolutePath == "/music/api/v1/search/track");
        Check(request.RequestUri.Query == "?q=" + Uri.EscapeDataString("中文 &?#+/歌曲") + "&page=2&size=25");
        return Json("""{"code":0,"data":{"total":26,"list":[{"guid":"search-track","title":"测试","duration":90000}]}}""");
    }));
    var found = await api.SearchTracksAsync("  中文 &?#+/歌曲  ", 2, 25, default);
    Check(found.Total == 26 && found.Tracks[0].Id == "search-track" && found.Tracks[0].DurationSeconds == 90);
});
await Test("search paginates complete results from servers ignoring page and size", async () =>
{
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"total":3,"list":[{"guid":"a"},{"guid":"b"},{"guid":"c"}]}}""")));
    Check((await api.SearchTracksAsync("test", 1, 1, default)).Tracks.Single().Id == "a");
    Check((await api.SearchTracksAsync("test", 2, 1, default)).Tracks.Single().Id == "b");
    var last = await api.SearchTracksAsync("test", 2, 2, default);
    Check(last.Tracks.Single().Id == "c" && last.Total == 3);
    Check((await api.SearchTracksAsync("test", 4, 1, default)).Tracks.Count == 0);
    Check((await api.SearchTracksAsync("test", int.MaxValue, 100, default)).Tracks.Count == 0);
});
await Test("search preserves server pages and rejects ambiguous oversized partial results", async () =>
{
    using var paged = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"total":3,"list":[{"guid":"b"}]}}""")));
    Check((await paged.SearchTracksAsync("test", 2, 1, default)).Tracks.Single().Id == "b");
    using var oversized = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"total":3,"list":[{"guid":"a"},{"guid":"b"}]}}""")));
    await Fails(MusicFailure.InvalidResponse, () => oversized.SearchTracksAsync("test", 1, 1, default));
    using var inconsistent = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"total":0,"list":[{"guid":"a"}]}}""")));
    await Fails(MusicFailure.InvalidResponse, () => inconsistent.SearchTracksAsync("test", 1, 50, default));
});
await Test("search rejects invalid input before HTTP and accepts empty result", async () =>
{
    int calls = 0;
    using var api = new NasApiClient(endpoint, new FakeHandler(_ => { calls++; return Json("""{"code":0,"data":{"total":0,"list":[]}}"""); }));
    foreach (var query in new[] { " ", new string('x',257) })
    {
        try { await api.SearchTracksAsync(query, 1, 50, default); throw new Exception("Invalid query accepted"); }
        catch (ArgumentException) { }
    }
    try { await api.SearchTracksAsync("test", 0, 50, default); throw new Exception("Invalid page accepted"); }
    catch (ArgumentOutOfRangeException) { }
    Check(calls == 0);
    var found = await api.SearchTracksAsync("test", 1, 50, default);
    Check(found.Total == 0 && found.Tracks.Count == 0 && calls == 1);
});
await Test("search handles expired sessions and malformed response", async () =>
{
    using var expired = new NasApiClient(endpoint, new FakeHandler(_ => new HttpResponseMessage(HttpStatusCode.Unauthorized)));
    await Fails(MusicFailure.Unauthorized, () => expired.SearchTracksAsync("test", 1, 50, default));
    using var malformed = new NasApiClient(endpoint, new FakeHandler(_ => Json("""{"code":0,"data":{"total":1,"list":[{"title":"private"}]}}""")));
    await Fails(MusicFailure.InvalidResponse, () => malformed.SearchTracksAsync("test", 1, 50, default));
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
sealed class AsyncFakeHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> response) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => response(request);
}
static class UriExtensions
{
    public static string Origin(this Uri uri) => uri.GetLeftPart(UriPartial.Authority) + "/";
}
