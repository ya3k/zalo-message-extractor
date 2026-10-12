import { GroupMessage } from 'zca-js';

/**
 * Đăng ký endpoint custom lấy lịch sử tin nhắn nhóm theo PR #370
 * Endpoint: ${api.zpwServiceMap.group_cloud_message[0]}/api/cm/getrecentv2
 *
 * Sử dụng tính năng api.custom() chính thức của zca-js
 * mà KHÔNG cần chỉnh sửa file trong node_modules.
 *
 * @param {import('zca-js').API} api
 */
export function registerCustomHistory(api) {
  if (!api || typeof api.custom !== 'function') {
    throw new Error('API instance không hợp lệ hoặc thiếu method api.custom');
  }

  // Tránh đăng ký lặp lại nếu method đã tồn tại
  if (typeof api.getGroupChatHistoryV2 === 'function') {
    return;
  }

  api.custom('getGroupChatHistoryV2', async ({ ctx, utils, props }) => {
    const { groupId: inputGroupId, count = 10 } = props || {};

    if (!inputGroupId) {
      throw new Error('groupId là bắt buộc');
    }

    let groupId = String(inputGroupId);
    if (groupId.startsWith('g')) {
      groupId = groupId.slice(1);
    }

    const cloudBase = api.zpwServiceMap?.group_cloud_message?.[0];
    if (!cloudBase) {
      throw new Error('Không tìm thấy service URL cho group_cloud_message trong zpwServiceMap');
    }

    const serviceURL = utils.makeURL(`${cloudBase}/api/cm/getrecentv2`);
    const messages = [];
    let cursor = 0;
    let lastPage = null;

    while (messages.length < count) {
      const batchCount = Math.min(50, count - messages.length);
      const params = {
        groupId,
        globalMsgId: cursor,
        count: batchCount,
        msgIds: [],
        imei: ctx.imei,
        src: 3
      };

      const encryptedParams = utils.encodeAES(JSON.stringify(params));
      if (!encryptedParams) {
        throw new Error('Mã hóa encryptedParams thất bại');
      }

      const requestUrl = utils.makeURL(serviceURL, {
        params: encryptedParams,
        nretry: 0
      });

      const response = await utils.request(requestUrl, {
        method: 'GET'
      });

      lastPage = await utils.resolve(response, (result) => {
        let data = result.data;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch {
            // Giữ nguyên data nếu không phải JSON string
          }
        }
        return data;
      });

      if (!lastPage || !Array.isArray(lastPage.groupMsgs)) {
        break;
      }

      for (const rawMsg of lastPage.groupMsgs) {
        if (messages.length >= count) break;
        if (messages.some((m) => m.msgId === rawMsg.msgId)) continue;
        messages.push(rawMsg);
      }

      const nextCursor = Number(lastPage.lastMsgId);
      if (!lastPage.hasMore || !nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }

    const groupMsgs = messages.map((msgData) => new GroupMessage(ctx.uid, msgData));
    return Object.assign({}, lastPage || {}, { groupMsgs });
  });
}

/**
 * Gọi lấy lịch sử tin nhắn nhóm qua endpoint V2 (Cloud Message)
 * @param {import('zca-js').API} api
 * @param {string} groupId
 * @param {number} [count=10]
 * @returns {Promise<{ raw: Object, messages: Array, pagination: Object }>}
 */
export async function fetchGroupHistoryV2(api, groupId, count = 10) {
  registerCustomHistory(api);

  const safeCount = Math.min(Math.max(1, count), 50);
  const result = await api.getGroupChatHistoryV2({ groupId, count: safeCount });

  return {
    raw: result,
    messages: result?.groupMsgs || [],
    pagination: {
      lastMsgId: result?.lastMsgId ?? null,
      minMsgId: result?.minMsgId ?? null,
      maxMsgId: result?.maxMsgId ?? null,
      hasMore: Boolean(result?.hasMore)
    }
  };
}
