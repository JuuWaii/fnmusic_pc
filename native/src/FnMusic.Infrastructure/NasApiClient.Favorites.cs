using FnMusic.Core;

namespace FnMusic.Infrastructure;

public sealed partial class NasApiClient
{
    public async Task<TrackPage> ListFavoritesAsync(int page, int size, CancellationToken ct)
    {
        ValidatePage(page, size);
        using var data = await RequestAsync(HttpMethod.Get, $"favorite-track/list?page={page}&size={size}", null, ct);
        var result = ParseTrackPage(data.RootElement);
        if (result.Tracks.Count > size || result.Tracks.Count > result.Total) throw new MusicApiException(MusicFailure.InvalidResponse);
        return new TrackPage(result.Tracks.Select(track => track with { IsFavorite = true }).ToArray(), result.Total);
    }
    public Task SetFavoriteAsync(TrackReference reference, bool favorite, CancellationToken ct)
    {
        ValidateReference(reference);
        return SetFavoriteAsync(reference.TrackId, favorite, ct);
    }
    public async Task SetFavoriteAsync(string trackId, bool favorite, CancellationToken ct)
    {
        _ = EncodeCollectionId(trackId);
        using var data = await RequestAsync(HttpMethod.Post, favorite ? "favorite-track/create" : "favorite-track/delete",
            new { trackGUID = trackId }, ct);
    }
}
