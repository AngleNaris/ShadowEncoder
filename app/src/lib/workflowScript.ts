import { getVideoInfo } from './ffmpeg';
import type { WorkflowAsset } from './workflowGraph';

export type ScriptPlan = { filterComplex: string; duration: number };
export type ScriptInput = { name: string; index: number; width: number; height: number; fps: number; duration: number };

export function validateScriptPlan(value: unknown): ScriptPlan {
  const plan = value as ScriptPlan | null;
  if (!plan || typeof plan.filterComplex !== 'string' || !plan.filterComplex.trim() || plan.filterComplex.length > 65536) throw new Error('脚本必须返回有效的 filterComplex（最多 64K 字符）');
  if (Object.keys(plan).some(key => !['filterComplex', 'duration'].includes(key))) throw new Error('脚本只允许返回 filterComplex 和 duration；编码、格式和输出设置请使用后续节点');
  if (!Number.isFinite(plan.duration) || plan.duration < 0.1 || plan.duration > 86400) throw new Error('脚本输出 duration 必须在 0.1 到 86400 秒之间');
  return { filterComplex: plan.filterComplex, duration: plan.duration };
}

// The opaque-origin frame gives its worker a network-denying CSP and no app IPC.
// All exits terminate the worker, revoke its URL and remove the frame.
export function evaluateWorkflowScript(script: string, inputs: ScriptInput[], isCancelled = () => false, syntaxOnly = false): Promise<ScriptPlan> {
  if (!script.trim() || script.length > 65536) return Promise.reject(new Error('脚本为空或超过 64K 字符'));
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.sandbox.add('allow-scripts');
    const token = crypto.randomUUID();
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timeout);
      clearInterval(cancelTimer);
      window.removeEventListener('message', onMessage);
      frame.contentWindow?.postMessage({ stop: token }, '*');
      frame.remove();
      if (error) reject(error);
      else { try { resolve(validateScriptPlan(value)); } catch (cause) { reject(cause); } }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.data?.token !== token) return;
      finish(event.data.error ? new Error(String(event.data.error)) : undefined, event.data.plan);
    };
    const timeout = window.setTimeout(() => finish(new Error('脚本执行超过 3 秒，已终止')), 3500);
    const cancelTimer = window.setInterval(() => { if (isCancelled()) finish(new Error('脚本已取消')); }, 100);
    window.addEventListener('message', onMessage);
    const workerCode = `onmessage = async ({data}) => { try {
      const fn = new Function('inputs', '"use strict";\\n' + data.script);
      const result = data.syntaxOnly ? {filterComplex: 'null[out]', duration: 1} : await fn(data.inputs);
      const json = JSON.stringify(result);
      if (!json || json.length > 70000) throw new Error('Script result exceeds 70K');
      postMessage({plan: JSON.parse(json)});
    } catch (error) { postMessage({error: String(error.message || error)}); } };`;
    const payload = JSON.stringify({ token, script, inputs, workerCode, syntaxOnly }).replace(/</g, '\\u003c');
    frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; connect-src 'none'"><script>
      const data = ${payload};
      const url = URL.createObjectURL(new Blob([data.workerCode], {type: 'text/javascript'}));
      const worker = new Worker(url);
      let finished = false;
      const stop = () => { worker.terminate(); URL.revokeObjectURL(url); clearTimeout(timer); };
      const done = result => { if (finished) return; finished = true; stop(); parent.postMessage({...result, token: data.token}, '*'); };
      const timer = setTimeout(() => done({error: '脚本执行超过 3 秒，已终止'}), 3000);
      onmessage = event => { if (event.data?.stop === data.token) stop(); };
      worker.onmessage = event => done(event.data);
      worker.onerror = event => done({error: event.message || '脚本执行失败'});
      worker.postMessage({script: data.script, inputs: data.inputs, syntaxOnly: data.syntaxOnly});
    <\/script>`;
    document.body.append(frame);
  });
}

export async function runWorkflowScript(script: string, assets: WorkflowAsset[], isCancelled: () => boolean): Promise<NonNullable<WorkflowAsset['preprocessing']>> {
  if (!assets.length) throw new Error('高级自定义节点没有输入素材');
  if (assets.length > 32) throw new Error('高级自定义节点最多接收 32 个素材');
  if (assets.some(asset => asset.preprocessing)) throw new Error('已有待编码的预处理计划，请先连接编码节点或将处理合并到同一脚本');
  const inputs = await Promise.all(assets.map(async (asset, index): Promise<ScriptInput> => {
    const info = await getVideoInfo(asset.path);
    return { name: asset.path.split(/[/\\]/).pop() || '', index, width: info.width, height: info.height, fps: info.fps, duration: info.duration };
  }));
  const plan = await evaluateWorkflowScript(script, inputs, isCancelled);
  if (isCancelled()) throw new Error('脚本已取消');
  return { paths: assets.map((asset) => asset.path), plan };
}
