namespace FnMusic.Core;

/// <summary>源实例 ID 应由本机生成并持久保存，每个账户独立；不得使用凭据或地址。</summary>
public sealed record MusicSource(Guid Id, string Name, string Provider, MusicSourceCapabilities Capabilities);

[Flags]
public enum MusicSourceCapabilities
{
    None = 0,
    Browse = 1,
    Playback = 2,
    Search = 4,
    ReadFavorites = 8,
    WriteFavorites = 16,
    ReadPlaylists = 32,
    WritePlaylists = 64,
    ReadSettings = 128,
    WriteSettings = 256,
    Artwork = 512,
    Lyrics = 1024
}

/// <summary>库归属不参与曲目身份，同一源的歌曲可属于多个库。</summary>
public sealed record MusicLibrary(Guid SourceInstanceId, string Id, string Name);

/// <summary>Empty 源 ID 仅用于尚未迁移的单源会话，不用于持久化跨源歌单。</summary>
public sealed record TrackReference(Guid SourceInstanceId, string TrackId);
