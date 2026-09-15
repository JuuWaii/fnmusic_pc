namespace FnMusic.Core;

public enum CollectionKind { Album, Artist }
public sealed record MusicCollection(string Id, string Name, int? TrackCount)
{
    public string Summary => TrackCount is int count ? $"{count} 首歌曲" : "歌曲数量未知";
}
public sealed record CollectionPage(IReadOnlyList<MusicCollection> Items, int Total);
