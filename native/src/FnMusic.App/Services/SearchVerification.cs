#if DEBUG
using System.Text.Json;
using FnMusic.App.ViewModels;

namespace FnMusic.App.Services;

// 显式使用本应用会话，只读请求；报告不包含关键词、曲目或连接信息。
internal static class SearchVerification
{
    public static async Task RunAsync()
    {
        var checks = new Dictionary<string, bool>();
        string stage = "session", error = "";
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        using var connection = new ConnectionViewModel();
        try
        {
            await connection.InitializeAsync();
            var api = connection.AuthenticatedClient ?? throw new InvalidOperationException();
            checks[stage] = true;
            stage = "known_track_search";
            var library = await api.ListTracksAsync(1, 1, timeout.Token);
            var track = library.Tracks.First();
            string query = track.Title[..Math.Min(64, track.Title.Length)];
            var found = await api.SearchTracksAsync(query, 1, 100, timeout.Token);
            if (!found.Tracks.Any(t => t.Id == track.Id)) throw new InvalidOperationException();
            checks[stage] = true;
            stage = "search_pagination";
            var first = await api.SearchTracksAsync(query, 1, 1, timeout.Token);
            if (first.Total != found.Total || first.Tracks.Count != 1) throw new InvalidOperationException();
            var second = await api.SearchTracksAsync(query, 2, 1, timeout.Token);
            if (second.Total != found.Total || (found.Total > 1 ? second.Tracks.Count != 1 || second.Tracks[0].Id == first.Tracks[0].Id : second.Tracks.Count != 0)) throw new InvalidOperationException();
            checks[stage] = true;
            stage = "empty_search";
            var empty = await api.SearchTracksAsync("fnmusic-verification-" + Guid.NewGuid().ToString("N"), 1, 1, timeout.Token);
            if (empty.Total != 0 || empty.Tracks.Count != 0) throw new InvalidOperationException();
            checks[stage] = true;
            stage = "complete";
        }
        catch (Exception ex) { error = ex.GetType().Name; }
        await File.WriteAllTextAsync(Path.Combine(AppContext.BaseDirectory, "search-verification.json"),
            JsonSerializer.Serialize(new { timestamp = DateTimeOffset.UtcNow, stage, error, checks }));
    }
}
#endif
