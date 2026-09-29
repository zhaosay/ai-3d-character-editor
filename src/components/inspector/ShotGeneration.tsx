import { useEffect, useRef, useState } from 'react';
import { buildComfyStoryboardRequest, buildVpipeStoryboardRequest, type StoryboardShot } from '../../core/previs/storyboard';
import { useMotionStore } from '../../stores/motionStore';
import { useAnimationStore } from '../../stores/animationStore';

interface JobState {
  imageId?: string;
  imageStatus?: string;
  imageError?: string;
  videoId?: string;
  videoStatus?: string;
  videoError?: string;
}

async function readResponse(response: Response) {
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data['detail'] ?? data['error'] ?? `HTTP ${response.status}`));
  return data;
}

async function imageAsDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`无法读取 ComfyUI 图片（HTTP ${response.status}）`);
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function captureStoryboardFrame(time: number): Promise<string> {
  const animation = useAnimationStore.getState();
  if (!animation.active()) throw new Error('请先载入人物并创建动画，再生成参考帧');
  const previousTime = animation.currentTime;
  const wasPlaying = animation.playing;
  animation.setPlaying(false);
  animation.setTime(time);
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-previs-viewport="true"]');
    if (!canvas || canvas.width === 0 || canvas.height === 0) throw new Error('3D 视口尚未就绪，无法捕获镜头参考帧');
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('视口截图失败，请重试')), 'image/png'));
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('视口截图读取失败'));
      reader.onerror = () => reject(new Error('视口截图读取失败'));
      reader.readAsDataURL(blob);
    });
    const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (!encoded) throw new Error('视口截图没有有效图像数据');
    return encoded;
  } finally {
    useAnimationStore.getState().setTime(previousTime);
    useAnimationStore.getState().setPlaying(wasPlaying);
  }
}

export function ShotGeneration({ shot, comfyAvailable, comfyReason, vpipeReady }: {
  shot: StoryboardShot;
  comfyAvailable: boolean | null;
  comfyReason: string;
  vpipeReady: boolean | null;
}) {
  const baseUrl = useMotionStore((state) => state.baseUrl.replace(/\/+$/, ''));
  const [job, setJob] = useState<JobState>({});
  const [busy, setBusy] = useState<'image' | 'video' | 'i2v' | null>(null);
  const polling = useRef(false);
  const pollAttempts = useRef(new Map<string, { attempts: number; errors: number }>());
  const imageUrl = job.imageId ? `${baseUrl}/integrations/comfy/jobs/${encodeURIComponent(job.imageId)}/image` : '';
  const videoUrl = job.videoId ? `${baseUrl}/integrations/vpipe/jobs/${encodeURIComponent(job.videoId)}/file` : '';
  const imagePending = Boolean(job.imageId && job.imageStatus !== 'completed' && job.imageStatus !== 'failed');
  const videoPending = Boolean(job.videoId && job.videoStatus !== 'completed' && job.videoStatus !== 'failed');

  useEffect(() => {
    if ((!job.imageId || job.imageStatus === 'completed' || job.imageStatus === 'failed')
      && (!job.videoId || job.videoStatus === 'completed' || job.videoStatus === 'failed')) return;
    const timer = window.setInterval(() => {
      if (polling.current) return;
      polling.current = true;
      const poll = (id: string, kind: 'image' | 'video') => {
        const progress = pollAttempts.current.get(id) ?? { attempts: 0, errors: 0 };
        progress.attempts += 1;
        pollAttempts.current.set(id, progress);
        if (progress.attempts > 30) {
          const message = '任务超过 2 分钟仍未完成，已停止轮询；请检查生成服务状态后再提交';
          setJob((current) => ({ ...current, [`${kind}Status`]: 'failed', [`${kind}Error`]: message }));
          return Promise.resolve({});
        }
        return fetch(`${baseUrl}/integrations/${kind === 'image' ? 'comfy' : 'vpipe'}/jobs/${encodeURIComponent(id)}`)
          .then(readResponse)
          .then((data) => {
            progress.errors = 0;
            return {
              [`${kind}Status`]: String(data['status']),
              [`${kind}Error`]: data['error'] ? JSON.stringify(data['error']) : undefined,
            };
          })
          .catch((error: unknown) => {
            progress.errors += 1;
            if (progress.errors >= 3) {
              return {
                [`${kind}Status`]: 'failed',
                [`${kind}Error`]: error instanceof Error ? error.message : '连续 3 次查询任务状态失败，已停止轮询',
              };
            }
            return {};
          });
      };
      void Promise.all([
        job.imageId && job.imageStatus !== 'completed' && job.imageStatus !== 'failed'
          ? poll(job.imageId, 'image')
          : Promise.resolve({}),
        job.videoId && job.videoStatus !== 'completed' && job.videoStatus !== 'failed'
          ? poll(job.videoId, 'video')
          : Promise.resolve({}),
      ]).then(([image, video]) => setJob((current) => ({ ...current, ...image, ...video })))
        .finally(() => { polling.current = false; });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [baseUrl, job.imageId, job.imageStatus, job.videoId, job.videoStatus]);

  const generateImage = async () => {
    setBusy('image');
    setJob((current) => ({ ...current, imageId: undefined, imageStatus: undefined, imageError: undefined }));
    try {
      const referenceImage = await captureStoryboardFrame((shot.t0 + shot.t1) / 2);
      const data = await readResponse(await fetch(`${baseUrl}/integrations/comfy/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildComfyStoryboardRequest(shot, referenceImage)),
      }));
      setJob((current) => ({ ...current, imageId: String(data['jobId']), imageStatus: 'queued', imageError: undefined }));
    } catch (error) {
      setJob((current) => ({ ...current, imageError: error instanceof Error ? error.message : 'ComfyUI 提交失败' }));
    } finally { setBusy(null); }
  };

  const generateVideo = async (withImage: boolean) => {
    setBusy(withImage ? 'i2v' : 'video');
    setJob((current) => ({ ...current, videoError: undefined }));
    try {
      const imageBase64 = withImage ? await imageAsDataUrl(imageUrl) : undefined;
      const data = await readResponse(await fetch(`${baseUrl}/integrations/vpipe/jobs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildVpipeStoryboardRequest(shot, imageBase64)),
      }));
      setJob((current) => ({ ...current, videoId: String(data['jobId']), videoStatus: String(data['status'] ?? 'queued'), videoError: undefined }));
    } catch (error) {
      setJob((current) => ({ ...current, videoError: error instanceof Error ? error.message : 'V-Pipe 提交失败' }));
    } finally { setBusy(null); }
  };

  const button = 'rounded px-2 py-1 text-[11px] text-white disabled:bg-zinc-300';
  return (
    <div className="mt-2 space-y-1.5 rounded border border-zinc-200 bg-white p-2">
      <div className="flex flex-wrap gap-1">
        <button onClick={() => void generateImage()} disabled={busy !== null || comfyAvailable !== true || imagePending} className={`${button} bg-indigo-600`}>
          {busy === 'image' ? '提交中…' : '视口参考图润色'}
        </button>
        <button onClick={() => void generateVideo(false)} disabled={busy !== null || vpipeReady !== true || videoPending} className={`${button} bg-sky-700`}>
          {busy === 'video' ? '提交中…' : 'V-Pipe 文生视频'}
        </button>
        <button onClick={() => void generateVideo(true)} disabled={busy !== null || vpipeReady !== true || videoPending || !imageUrl || job.imageStatus !== 'completed'} className={`${button} bg-emerald-700`}>
          {busy === 'i2v' ? '提交中…' : '静帧转视频'}
        </button>
      </div>
      <div className="text-[10px] text-zinc-500">
        ComfyUI {comfyAvailable === null ? '检测中' : comfyAvailable ? '可用' : comfyReason || '当前不可用'} · V-Pipe {vpipeReady === null ? '检测中' : vpipeReady ? '已连接' : '未连接'}
      </div>
      {job.imageId && <div className="text-[10px] text-zinc-600">图片任务 {job.imageId.slice(0, 8)} · {job.imageStatus}</div>}
      {job.imageError && <div role="alert" className="text-[10px] text-red-600">ComfyUI：{job.imageError}</div>}
      {job.imageStatus === 'completed' && imageUrl && <img src={imageUrl} alt={`镜头 ${shot.index} 的 ComfyUI 参考图`} className="max-h-52 w-full rounded object-contain" />}
      {job.videoId && <div className="text-[10px] text-zinc-600">视频任务 {job.videoId.slice(0, 8)} · {job.videoStatus}</div>}
      {job.videoError && <div role="alert" className="text-[10px] text-red-600">V-Pipe：{job.videoError}</div>}
      {job.videoStatus === 'completed' && videoUrl && <video src={videoUrl} controls className="max-h-64 w-full rounded bg-black" />}
    </div>
  );
}
