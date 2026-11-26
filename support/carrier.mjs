// 接续承运台外部协议客户端。
// 只传递执行运输所必需的乘客范围；网络超时/断连必须保留为“回执未明”，不能当作未受理。

function joinUrl(base, pathname) {
  return String(base).replace(/\/+$/, '') + pathname;
}

export async function submitDispatches({ baseUrl, key, items, timeoutMs = 4000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(joinUrl(baseUrl, '/coach/dispatches'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'dispatch-key': key,
      },
      body: JSON.stringify({ passengers: items }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { ok: response.ok, status: response.status, body, unknown: false };
  } catch (error) {
    // 请求可能已经到达合作方并完成持久受理，因此所有发送失败都按回执未明处理。
    return {
      ok: false,
      unknown: true,
      error: error?.name === 'AbortError' ? '承运台请求超时，回执未明' : `承运台连接中断，回执未明：${error?.message ?? error}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDispatch({ baseUrl, dispatchNo, timeoutMs = 4000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(joinUrl(baseUrl, '/coach/dispatches/' + encodeURIComponent(dispatchNo)), {
      method: 'GET',
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body, unknown: !response.ok };
  } catch (error) {
    return { ok: false, unknown: true, error: `承运台查询失败：${error?.message ?? error}` };
  } finally {
    clearTimeout(timer);
  }
}
