using System.Text.Json;
using FnMusic.Core;

namespace FnMusic.Infrastructure;

public sealed partial class NasApiClient
{
    private static string CollectionPath(CollectionKind kind) => kind switch
    {
        CollectionKind.Album => "album", CollectionKind.Artist => "artist",
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };
    private static void ValidatePage(int page, int size)
    {
        if (page < 1 || size is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(page));
    }
    private static string EncodeCollectionId(string id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 256) throw new ArgumentException("Invalid collection identifier");
        return Uri.EscapeDataString(id);
    }
    public async Task<CollectionPage> ListCollectionsAsync(CollectionKind kind, int page, int size, CancellationToken ct)
    {
        ValidatePage(page, size);
        using var data = await RequestAsync(HttpMethod.Get, $"{CollectionPath(kind)}/list?page={page}&size={size}", null, ct);
        return ParseCollectionPage(data.RootElement, size);
    }
    public async Task<CollectionPage> ListArtistAlbumsAsync(string artistId, int page, int size, CancellationToken ct)
    {
        ValidatePage(page, size);
        using var data = await RequestAsync(HttpMethod.Get,
            $"album/artist-detail/list?artistGUID={EncodeCollectionId(artistId)}&page={page}&size={size}", null, ct);
        return ParseCollectionPage(data.RootElement, size);
    }
    private static CollectionPage ParseCollectionPage(JsonElement root, int size)
    {
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("list", out var list) || list.ValueKind != JsonValueKind.Array ||
            !root.TryGetProperty("total", out var total) || total.ValueKind != JsonValueKind.Number || !total.TryGetInt32(out int count) || count < 0)
            throw new MusicApiException(MusicFailure.InvalidResponse);
        var items = list.EnumerateArray().Select(ParseCollection).ToArray();
        if (items.Length > size || items.Length > count) throw new MusicApiException(MusicFailure.InvalidResponse);
        return new CollectionPage(items, count);
    }
    public async Task<MusicCollection> GetCollectionAsync(CollectionKind kind, string id, CancellationToken ct)
    {
        string path = CollectionPath(kind);
        using var data = await RequestAsync(HttpMethod.Get, $"{path}/detail?guid={EncodeCollectionId(id)}", null, ct);
        var root = data.RootElement;
        // 已审查前端兼容直接专辑对象与 { album } 包装；歌手为直接对象。
        if (kind == CollectionKind.Album && root.ValueKind == JsonValueKind.Object && root.TryGetProperty("album", out var album)) root = album;
        var result = ParseCollection(root);
        if (result.Id != id) throw new MusicApiException(MusicFailure.InvalidResponse);
        return result;
    }
    public async Task<TrackPage> ListCollectionTracksAsync(CollectionKind kind, string id, int page, int size, CancellationToken ct)
    {
        ValidatePage(page, size);
        string path = CollectionPath(kind);
        string sort = kind == CollectionKind.Album ? "&sort=trackNo%2Casc" : "";
        using var data = await RequestAsync(HttpMethod.Get,
            $"track/{path}-detail/list?{path}GUID={EncodeCollectionId(id)}&page={page}&size={size}{sort}", null, ct);
        var result = ParseTrackPage(data.RootElement);
        if (result.Tracks.Count > size || result.Tracks.Count > result.Total) throw new MusicApiException(MusicFailure.InvalidResponse);
        return result;
    }
    private static MusicCollection ParseCollection(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object || !item.TryGetProperty("guid", out var id) || id.ValueKind != JsonValueKind.String ||
            string.IsNullOrWhiteSpace(id.GetString()) || id.GetString()!.Length > 256 ||
            !item.TryGetProperty("name", out var name) || name.ValueKind != JsonValueKind.String)
            throw new MusicApiException(MusicFailure.InvalidResponse);
        int? count = null;
        if (item.TryGetProperty("trackCount", out var tracks) && tracks.ValueKind != JsonValueKind.Null)
        {
            if (tracks.ValueKind != JsonValueKind.Number || !tracks.TryGetInt32(out int value) || value < 0)
                throw new MusicApiException(MusicFailure.InvalidResponse);
            count = value;
        }
        return new MusicCollection(id.GetString()!, name.GetString()!, count);
    }
}
