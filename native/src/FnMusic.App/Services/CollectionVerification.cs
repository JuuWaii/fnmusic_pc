#if DEBUG
using System.Text.Json;
using FnMusic.Core;
using FnMusic.App.ViewModels;

namespace FnMusic.App.Services;

// 仅显式运行；使用应用自身会话，只执行 GET，报告不含业务数据或凭据。
internal static class CollectionVerification
{
    public static async Task RunAsync()
    {
        var checks = new Dictionary<string, bool>();
        var skipped = new List<string>();
        string stage = "session", error = "";
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(90));
        using var connection = new ConnectionViewModel();
        try
        {
            await connection.InitializeAsync();
            var api = connection.AuthenticatedClient ?? throw new InvalidOperationException();
            checks[stage] = true;
            foreach (var kind in new[] { CollectionKind.Album, CollectionKind.Artist })
            {
                string prefix = kind == CollectionKind.Album ? "album" : "artist";
                stage = prefix + "_list";
                var first = await api.ListCollectionsAsync(kind, 1, 1, timeout.Token);
                checks[stage] = first.Items.Count == (first.Total > 0 ? 1 : 0);
                if (first.Items.Count == 0) { skipped.Add(prefix + "_detail_and_pagination_empty_library"); continue; }
                if (first.Total > 1)
                {
                    stage = prefix + "_list_pagination";
                    var second = await api.ListCollectionsAsync(kind, 2, 1, timeout.Token);
                    checks[stage] = second.Total == first.Total && second.Items.Count == 1 && second.Items[0].Id != first.Items[0].Id;
                }
                else skipped.Add(prefix + "_list_pagination_single_item");
                stage = prefix + "_detail";
                var item = first.Items[0];
                // 有界选择多曲目集合，避免把单曲专辑上的跳过误报为分页通过。
                if (item.TrackCount is null or < 2)
                {
                    stage = prefix + "_pagination_fixture";
                    var candidates = await api.ListCollectionsAsync(kind, 1, 50, timeout.Token);
                    item = candidates.Items.FirstOrDefault(candidate => candidate.TrackCount >= 2) ?? item;
                }
                stage = prefix + "_detail";
                var detail = await api.GetCollectionAsync(kind, item.Id, timeout.Token);
                checks[stage] = detail.Id == item.Id && detail.Name == item.Name;
                stage = prefix + "_tracks";
                var tracks = await api.ListCollectionTracksAsync(kind, item.Id, 1, 1, timeout.Token);
                checks[stage] = tracks.Tracks.Count == (tracks.Total > 0 ? 1 : 0);
                if (tracks.Total > 1)
                {
                    stage = prefix + "_track_pagination";
                    var next = await api.ListCollectionTracksAsync(kind, item.Id, 2, 1, timeout.Token);
                    checks[stage] = next.Total == tracks.Total && next.Tracks.Count == 1 && next.Tracks[0].Id != tracks.Tracks[0].Id;
                }
                else skipped.Add(prefix + "_track_pagination_insufficient_items");
                if (kind == CollectionKind.Artist)
                {
                    stage = "artist_albums_list";
                    var albums = await api.ListArtistAlbumsAsync(item.Id, 1, 1, timeout.Token);
                    checks[stage] = albums.Items.Count == (albums.Total > 0 ? 1 : 0);
                    if (albums.Total > 1)
                    {
                        stage = "artist_albums_pagination";
                        var nextAlbums = await api.ListArtistAlbumsAsync(item.Id, 2, 1, timeout.Token);
                        checks[stage] = nextAlbums.Total == albums.Total && nextAlbums.Items.Count == 1 && nextAlbums.Items[0].Id != albums.Items[0].Id;
                    }
                    else skipped.Add("artist_albums_pagination_insufficient_items");
                    if (albums.Items.Count > 0)
                    {
                        stage = "artist_album_detail";
                        var album = albums.Items[0];
                        var albumDetail = await api.GetCollectionAsync(CollectionKind.Album, album.Id, timeout.Token);
                        checks[stage] = albumDetail.Id == album.Id && albumDetail.Name == album.Name;
                        stage = "artist_album_tracks";
                        var albumTracks = await api.ListCollectionTracksAsync(CollectionKind.Album, album.Id, 1, 1, timeout.Token);
                        checks[stage] = albumTracks.Tracks.Count == (albumTracks.Total > 0 ? 1 : 0);
                    }
                    else skipped.Add("artist_album_detail_empty_list");
                }
            }
            stage = checks.Values.All(value => value) ? (skipped.Count == 0 ? "complete" : "complete_with_skips") : "contract_mismatch";
        }
        catch (Exception ex) { error = ex.GetType().Name; }
        await File.WriteAllTextAsync(Path.Combine(AppContext.BaseDirectory, "collection-verification.json"),
            JsonSerializer.Serialize(new { timestamp = DateTimeOffset.UtcNow, stage, error, checks, skipped }));
    }
}
#endif
