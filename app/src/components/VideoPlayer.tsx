// ShadowEncoder 统一播放器 —— 复刻原 CvPlayer 交互（性能：按需绘制，不整文件进内存）
import React, {
  forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback,
} from 'react';

export interface CropRectResult {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VideoPlayerHandle {
  loadVideo: (src: string) => void;
  getCurrentTime: () => number;
  getCropRect: () => CropRectResult;
  setCropAspect: (w: number, h: number) => void;
  clearCrop: () => void;
  setLoopRange: (start: number, end: number) => void;
}

interface Props {
  src?: string;
  onFrame?: (timeSec: number) => void;
  onCropChange?: (rect: CropRectResult) => void;
  compact?: boolean;
  /** 需要透明棋盘格时 true；普通预览 false 直接用 video 更省 */
  alphaPreview?: boolean;
  /** 是否允许在播放器上绘制/编辑裁剪选区；不支持选取截取输出的页面传 false */
  cropEnabled?: boolean;
  /** 锁定选区：禁止绘制、移动、缩放（仅用于展示） */
  cropLocked?: boolean;
}

function checkerboard(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const s = 16;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      const on = ((x / s) + (y / s)) % 2 === 0;
      ctx.fillStyle = on ? '#2a2730' : '#1a1820';
      ctx.fillRect(x, y, s, s);
    }
  }
}

const VideoPlayer = forwardRef<VideoPlayerHandle, Props>((props, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const onFrameRef = useRef(props.onFrame);
  onFrameRef.current = props.onFrame;
  const alpha = props.alphaPreview === true;
  const cropEnabled = props.cropEnabled === true;
  const cropLocked = props.cropLocked === true;

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const aspectRef = useRef<number | null>(null);
  const loopRef = useRef<{ s: number; e: number }>({ s: 0, e: 0 });
  type DragState = {
    startX: number;
    startY: number;
    mode: 'new' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se';
    offX?: number;
    offY?: number;
  };
  const dragRef = useRef<DragState | null>(null);
  const needPaintRef = useRef(true);

  const paintOnce = useCallback(() => {
    if (!alpha) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || v.videoWidth <= 0) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    checkerboard(ctx, c.width, c.height);
    try {
      ctx.drawImage(v, 0, 0, c.width, c.height);
    } catch { /* decode */ }
  }, [alpha]);

  // 仅在播放中或标记 needPaint 时跑 rAF；暂停后最多画一帧
  useEffect(() => {
    if (!alpha) return;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      if (playing || needPaintRef.current) {
        paintOnce();
        needPaintRef.current = false;
        if (playing && videoRef.current) {
          const t = videoRef.current.currentTime;
          setTime(t);
          onFrameRef.current?.(t);
          const lr = loopRef.current;
          if (lr.e > lr.s && t >= lr.e) {
            videoRef.current.currentTime = lr.s;
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [alpha, playing, paintOnce]);

  // 非 alpha：用 interval 轻量更新时间
  useEffect(() => {
    if (alpha || !playing) return;
    const id = window.setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      setTime(v.currentTime);
      onFrameRef.current?.(v.currentTime);
      const lr = loopRef.current;
      if (lr.e > lr.s && v.currentTime >= lr.e) v.currentTime = lr.s;
    }, 100);
    return () => clearInterval(id);
  }, [alpha, playing]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setCrop(null);
    setReady(false);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    if (!props.src) {
      v.removeAttribute('src');
      v.load();
      return;
    }
    v.src = props.src;
    v.load();
    needPaintRef.current = true;
  }, [props.src]);

  useImperativeHandle(ref, () => ({
    loadVideo: (src: string) => {
      const v = videoRef.current;
      if (!v) return;
      v.src = src;
      v.load();
      setCrop(null);
      setReady(false);
      setPlaying(false);
      needPaintRef.current = true;
    },
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
    getCropRect: () => {
      const v = videoRef.current;
      const el = alpha ? canvasRef.current : videoRef.current;
      if (!v || !el || !crop || crop.w <= 0 || crop.h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const scale = Math.min(cw / v.videoWidth, ch / v.videoHeight);
      const offX = (cw - v.videoWidth * scale) / 2;
      const offY = (ch - v.videoHeight * scale) / 2;
      const vx = Math.round((crop.x - offX) / scale);
      const vy = Math.round((crop.y - offY) / scale);
      const vw = Math.round(crop.w / scale);
      const vh = Math.round(crop.h / scale);
      return {
        x: Math.max(0, vx),
        y: Math.max(0, vy),
        w: Math.min(v.videoWidth - Math.max(0, vx), vw),
        h: Math.min(v.videoHeight - Math.max(0, vy), vh),
      };
    },
    setCropAspect: (w: number, h: number) => {
      aspectRef.current = h > 0 ? w / h : null;
    },
    clearCrop: () => setCrop(null),
    setLoopRange: (s: number, e: number) => {
      loopRef.current = { s, e };
    },
  }));

  const stageRef = useRef<HTMLDivElement>(null);
  const HANDLE_HIT = 12;
  const onDown = (e: React.MouseEvent) => {
    if (!cropEnabled || cropLocked) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const c = crop;
    if (c && c.w > 0 && c.h > 0) {
      const corners: Record<string, [number, number]> = {
        'nw': [c.x, c.y],
        'ne': [c.x + c.w, c.y],
        'sw': [c.x, c.y + c.h],
        'se': [c.x + c.w, c.y + c.h],
      };
      for (const k of Object.keys(corners)) {
        const [hx, hy] = corners[k];
        if (Math.abs(x - hx) <= HANDLE_HIT && Math.abs(y - hy) <= HANDLE_HIT) {
          dragRef.current = { startX: x, startY: y, mode: `resize-${k}` as DragState['mode'] };
          return;
        }
      }
      const inside = x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h;
      if (inside) {
        dragRef.current = { startX: x, startY: y, mode: 'move', offX: x - c.x, offY: y - c.y };
        return;
      }
    }
    dragRef.current = { startX: x, startY: y, mode: 'new' };
    setCrop({ x, y, w: 0, h: 0 });
  };
  const onMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const d = dragRef.current;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(v, max));
    if (d.mode === 'new') {
      let w = x - d.startX;
      let h = y - d.startY;
      let nx = d.startX;
      let ny = d.startY;
      if (w < 0) { nx = x; w = -w; }
      if (h < 0) { ny = y; h = -h; }
      if (aspectRef.current) h = Math.round(w / aspectRef.current);
      setCrop({ x: nx, y: ny, w, h });
    } else if (d.mode === 'move' && crop) {
      const nx = clamp(x - (d.offX ?? 0), cw - crop.w);
      const ny = clamp(y - (d.offY ?? 0), ch - crop.h);
      setCrop({ ...crop, x: nx, y: ny });
    } else if (crop) {
      const c = crop;
      let left = c.x, top = c.y, right = c.x + c.w, bottom = c.y + c.h;
      const hasW = d.mode.includes('w');
      const hasE = d.mode.includes('e');
      const hasN = d.mode.includes('n');
      const hasS = d.mode.includes('s');
      if (hasW) { left = clamp(x, cw); left = Math.min(left, right - 4); }
      if (hasE) { right = clamp(x, cw); right = Math.max(right, left + 4); }
      if (hasN) { top = clamp(y, ch); top = Math.min(top, bottom - 4); }
      if (hasS) { bottom = clamp(y, ch); bottom = Math.max(bottom, top + 4); }
      let w = right - left;
      let h = bottom - top;
      if (aspectRef.current) {
        h = Math.round(w / aspectRef.current);
        if (hasN) top = bottom - h; else bottom = top + h;
      }
      setCrop({ x: left, y: top, w, h });
    }
  };
  const onUp = () => {
    if (dragRef.current && crop) {
      if (crop.w < 4 || crop.h < 4) {
        setCrop(null);
        props.onCropChange?.({ x: 0, y: 0, w: 0, h: 0 });
      } else {
        const handle = (ref as React.MutableRefObject<VideoPlayerHandle | null>).current;
        if (handle) props.onCropChange?.(handle.getCropRect());
      }
    }
    dragRef.current = null;
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      void v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
      needPaintRef.current = true;
    }
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const t = parseFloat(e.target.value);
    v.currentTime = t;
    setTime(t);
    onFrameRef.current?.(t);
    needPaintRef.current = true;
  };

  return (
    <div className="se-player">
      <div
        ref={stageRef}
        className="se-player-stage"
        style={{
          cursor: cropEnabled && !cropLocked
            ? (dragRef.current?.mode === 'move'
              ? 'move'
              : dragRef.current?.mode?.startsWith('resize')
                ? 'nwse-resize'
                : 'crosshair')
            : undefined,
        }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
      >
        {alpha ? (
          <canvas ref={canvasRef} className="se-player-canvas" />
        ) : (
          <video
            ref={videoRef}
            className="se-player-video"
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration);
              setReady(true);
              needPaintRef.current = true;
            }}
            onSeeked={() => { needPaintRef.current = true; }}
          />
        )}
        {alpha && (
          <video
            ref={videoRef}
            style={{ display: 'none' }}
            preload="metadata"
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration);
              setReady(true);
              needPaintRef.current = true;
            }}
            onSeeked={() => { needPaintRef.current = true; }}
          />
        )}
        {crop && crop.w > 0 && crop.h > 0 && cropEnabled && (
          <div className={`se-crop-box${cropLocked ? ' locked' : ''}`} style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h }}>
            <span className="se-crop-label">{Math.round(crop.w)}×{Math.round(crop.h)}</span>
            {!cropLocked && (
              <>
                <span className="se-crop-handle nw" />
                <span className="se-crop-handle ne" />
                <span className="se-crop-handle sw" />
                <span className="se-crop-handle se" />
              </>
            )}
          </div>
        )}
        {!ready && (
          <div className="se-player-overlay">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <rect x="3" y="5" width="18" height="14" />
              <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
            </svg>
            <span className="se-player-hint">在左侧单击素材以预览</span>
          </div>
        )}
      </div>
      <div className="se-player-controls">
        <button type="button" className="se-icon-btn" onClick={togglePlay} disabled={!ready} title={playing ? '暂停' : '播放'}>
          {playing ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="4" width="5" height="16" /><rect x="14" y="4" width="5" height="16" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 4l12 8-12 8V4z" /></svg>
          )}
        </button>
        <span className="se-time">{time.toFixed(2)}s</span>
        <input
          className="se-seek"
          type="range"
          min={0}
          max={duration || 0}
          step={0.001}
          value={time}
          onChange={onSeek}
          disabled={!ready}
          style={{
            background: duration > 0
              ? `linear-gradient(90deg, var(--primary) ${(time / duration) * 100}%, var(--surface-4) ${(time / duration) * 100}%)`
              : undefined,
          }}
        />
        <span className="se-time">{duration.toFixed(2)}s</span>
      </div>
    </div>
  );
});

VideoPlayer.displayName = 'VideoPlayer';
export default VideoPlayer;
