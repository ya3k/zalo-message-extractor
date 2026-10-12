/**
 * Module truy xuat lich su tin nhan nhom Zalo
 */

import { fetchGroupHistoryV2 } from './custom-history.js';

export { fetchGroupHistoryV2 };

/**
 * Lay lich su tin nhan cua mot nhom
 * @param {import('zca-js').API} api
 * @param {string} groupId - ID cua nhom
 * @param {number} [count=10] - So luong tin nhan can lay (mac dinh 10 tin cho POC)
 * @param {Object} [options={}]
 * @param {boolean} [options.fallbackV2=true] - Tu dong thu endpoint V2 (PR #370) neu endpoint goc bi 404
 * @returns {Promise<{ raw: Object, messages: Array, usedEndpoint: string }>}
 */
export async function fetchGroupHistory(api, groupId, count = 10, options = {}) {
  const { fallbackV2 = false } = options;

  if (!api || typeof api.getGroupChatHistory !== 'function') {
    throw new Error('API instance khong hop le hoac thieu method getGroupChatHistory');
  }

  if (!groupId || typeof groupId !== 'string') {
    throw new Error('groupId la bat buoc va phai la kieu chuoi');
  }

  const safeCount = Math.min(Math.max(1, count), 50);

  try {
    const rawResponse = await api.getGroupChatHistory(groupId, safeCount);
    const groupMsgs = rawResponse?.groupMsgs || [];

    return {
      raw: rawResponse,
      messages: groupMsgs,
      usedEndpoint: 'v1-default',
      pagination: {
        lastActionId: rawResponse?.lastActionId || null,
        lastActionIdOther: rawResponse?.lastActionIdOther || null,
        hasMore: Boolean(rawResponse?.more)
      }
    };
  } catch (error) {
    const is404 = error.status === 404 || error.code === 404 || String(error.message).includes('404');

    if (fallbackV2 && is404) {
      console.warn('[History] Endpoint goc /api/group/history tra ve 404. Chuyen sang endpoint V2 (PR #370: group_cloud_message/api/cm/getrecentv2)...');
      const v2Result = await fetchGroupHistoryV2(api, groupId, safeCount);
      return {
        ...v2Result,
        usedEndpoint: 'v2-cloud'
      };
    }

    // Xu ly va lam sach thong tin loi
    const sanitizedError = {
      message: error.message || 'Unknown error',
      code: error.code || error.status || null,
      name: error.name || 'Error',
      method: 'api.getGroupChatHistory',
      package: 'zca-js@2.2.0'
    };

    const enhancedError = new Error(`Loi khi goi getGroupChatHistory: ${sanitizedError.message}`);
    enhancedError.details = sanitizedError;
    enhancedError.originalError = error;
    throw enhancedError;
  }
}
