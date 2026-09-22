#if DEBUG
using System.Text.Json;
using FnMusic.App.ViewModels;

namespace FnMusic.App.Services;

// 显式只读检查，不执行收藏增删；输出仅包含固定检查项。
internal static class FavoriteVerification
{
    public static async Task RunAsync()
    {
        var checks = new Dictionary<string, bool>();
        var skipped = new List<string>();
        string stage = "session", error = "";
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(60));
        using var connection = new ConnectionViewModel();
        try
        {
            await connection.InitializeAsync();
            var api = connection.AuthenticatedClient ?? throw new InvalidOperationException();
            checks[stage] = true;
            stage = "favorites_first_page";
            var first = await api.ListFavoritesAsync(1, 1, timeout.Token);
            checks[stage] = first.Tracks.Count == (first.Total > 0 ? 1 : 0);
            if (first.Tracks.Count > 0)
            {
                checks["favorite_state"] = first.Tracks[0].IsFavorite;
                stage = "favorites_repeat_read";
                var repeat = await api.ListFavoritesAsync(1, 1, timeout.Token);
                checks[stage] = repeat.Total == first.Total && repeat.Tracks.Count == 1 && repeat.Tracks[0].Id == first.Tracks[0].Id;
            }
            else skipped.Add("favorite_state_empty_library");
            if (first.Total > 1)
            {
                stage = "favorites_pagination";
                var next = await api.ListFavoritesAsync(2, 1, timeout.Token);
                checks[stage] = next.Total == first.Total && next.Tracks.Count == 1 && next.Tracks[0].Id != first.Tracks[0].Id && next.Tracks[0].IsFavorite;
            }
            else skipped.Add("favorites_pagination_insufficient_items");
            stage = checks.Values.All(x => x) ? skipped.Count == 0 ? "complete" : "complete_with_skips" : "contract_mismatch";
        }
        catch (Exception ex) { error = ex.GetType().Name; }
        await File.WriteAllTextAsync(Path.Combine(AppContext.BaseDirectory, "favorite-verification.json"),
            JsonSerializer.Serialize(new { timestamp = DateTimeOffset.UtcNow, stage, error, checks, skipped }));
    }
}
#endif
