import { GroupMessage } from 'zca-js';

/**
 * Dang ky endpoint custom lay lich su tin nhan nhom theo PR #370
 * Endpoint: ${api.zpwServiceMap.group_cloud_message[0]}/api/cm/getrecentv2
 *
 * Phuong phap nay su dung tinh nang api.custom() co san cua zca-js
 * ma KHONG can chinh sua bat ky file nao trong node_modules.
 *
 * @param {import('zca-js').API} api
 */
export function registerCustomHistory(api) {
  if (!api || typeof api.custom !== 'function') {
    throw new Error('API instance khong hop le hoac thieu method api.custom');
  }

  // Tranh dang ky lai neu da ton tai
  if (typeof api.getGroupChatHistoryV2 === 'function') {
    return;
  }

  api.custom('getGroupChatHistoryV2', async ({ ctx, utils, props }) => {
    const { groupId: inputGroupId, count = 10 } = props || {};

    if (!inputGroupId) {
      throw new Error('groupId la bat buoc');
    }

    let groupId = String(inputGroupId);
    if (groupId.startsWith('g')) {
      groupId = groupId.slice(1);
    }

    const cloudBase = api.zpwServiceMap?.group_cloud_message?.[0];
    if (!cloudBase) {
      throw new Error('Khong tim thay service URL cho group_cloud_message trong zpwServiceMap');
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
        throw new Error('Ma hoa encryptedParams that bai');
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
            // giu nguyen data neu khong phai JSON string
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
 * Goi lay lich su tin nhan nhom qua endpoint V2 (Cloud Message)
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
