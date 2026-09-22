namespace FnMusic.Core;

public enum QueueMode { Sequential, RepeatAll, RepeatOne, Shuffle }

/// <summary>播放时固定曲目快照；翻页不改变正在播放的队列。</summary>
public sealed class PlaybackQueue(Random? random = null)
{
    private readonly Random random = random ?? Random.Shared;
    private MusicTrack[] tracks = [];
    private readonly Stack<int> history = new();
    public QueueMode Mode { get; set; }
    public int Index { get; private set; } = -1;
    public int Count => tracks.Length;
    public IReadOnlyList<MusicTrack> Tracks => Array.AsReadOnly(tracks);
    public MusicTrack? Current => Index >= 0 && Index < tracks.Length ? tracks[Index] : null;

    public bool Replace(IEnumerable<MusicTrack> source, TrackReference selectedReference)
    {
        // 未支持的 CUE 不进入自动续播，避免在曲间意外停住。
        var next = source.Where(t => !t.IsCue).DistinctBy(t => t.Reference).ToArray();
        int selected = Array.FindIndex(next, t => t.Reference == selectedReference);
        if (selected < 0) return false;
        tracks = next; Index = selected; history.Clear();
        return true;
    }
    public MusicTrack? Next(bool automatic)
    {
        if (Current is null) return null;
        if (automatic && Mode == QueueMode.RepeatOne) return Current;
        int next;
        if (Mode == QueueMode.Shuffle)
        {
            if (Count == 1) return automatic ? null : Current;
            next = random.Next(Count - 1);
            if (next >= Index) next++;
        }
        else
        {
            next = Index + 1;
            if (next >= Count)
            {
                if (Mode == QueueMode.Sequential) return null;
                next = 0;
            }
        }
        history.Push(Index); Index = next;
        return Current;
    }
    public MusicTrack? Previous()
    {
        if (Current is null) return null;
        if (history.TryPop(out int previous)) Index = previous;
        else if (Index > 0) Index--;
        else if (Mode is QueueMode.RepeatAll or QueueMode.RepeatOne) Index = Count - 1;
        else return null;
        return Current;
    }
    public MusicTrack? Select(TrackReference reference)
    {
        int selected = Array.FindIndex(tracks, t => t.Reference == reference);
        if (selected < 0) return null;
        if (Index >= 0 && Index != selected) history.Push(Index);
        Index = selected;
        return Current;
    }
    // 当前曲目由窗口负责停止；删除其他曲目保持当前曲目身份。
    public bool Remove(TrackReference reference)
    {
        int removed = Array.FindIndex(tracks, t => t.Reference == reference);
        if (removed < 0) return false;
        tracks = tracks.Where(t => t.Reference != reference).ToArray();
        if (removed == Index) Index = -1;
        else if (removed < Index) Index--;
        history.Clear(); // 索引已变化，旧随机播放历史不再有效。
        return true;
    }
    public void Clear() { tracks = []; Index = -1; history.Clear(); }
}
