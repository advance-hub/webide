export const busyStates = new Set(['queued', 'preparing', 'starting', 'stopping', 'resetting', 'deleting', 'updating']);
export const labels: Record<string, string> = {
  queued: '排队中',
  preparing: '准备环境中',
  starting: '启动中',
  ready: '已就绪',
  failed: '出错',
  stopped: '已停止',
  stopping: '停止中',
  resetting: '重置文件中',
  deleting: '删除中',
  updating: '更新 IDE 中',
  none: '未创建',
};
export const opLabels: Record<string, string> = {
  start: '启动工作区',
  stop: '停止 IDE',
  restart: '重启 IDE',
  reset: '重置文件',
  delete: '删除工作区',
};
export const driverLabels: Record<string, string> = {
  local: '本地直连',
  sandbox: 'OpenSandbox 沙箱',
};
export function repository(url: string) {
  try {
    return new URL(url).pathname.replace(/^\//, '').replace(/\.git$/, '');
  } catch {
    return url;
  }
}
export function date(value?: string) {
  if (!value) {
    return '暂无记录';
  }
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
export function projectHref(id: string, tab = 'workspace') {
  return `/projects/${id}?tab=${tab}`;
}
