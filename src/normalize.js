/**
 * Module chuan hoa du lieu tin nhan tu Zalo sang schema JSON tieu chuan
 */

/**
 * Xac thuc va chuan hoa timestamp
 * @param {string|number} rawTs
 * @returns {number|null} - Timestamp tinh theo milliseconds hoac null neu khong hop le
 */
export function normalizeTimestamp(rawTs) {
  if (rawTs === null || rawTs === undefined || rawTs === '') {
    return null;
  }

  const num = typeof rawTs === 'number' ? rawTs : Number(rawTs);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }

  // Zalo thuong tra ve timestamp theo milliseconds (13 chu so).
  // Neu timestamp nho hon 10^11 (10 chu so - giay), doi sang milliseconds.
  if (num < 100000000000) {
    return num * 1000;
  }

  return num;
}

/**
 * Chuan hoa noi dung tin nhan (content)
 * @param {any} rawContent
 * @returns {string|Object|null}
 */
export function normalizeContent(rawContent) {
  if (rawContent === null || rawContent === undefined) {
    return null;
  }

  if (typeof rawContent === 'string') {
    return rawContent;
  }

  if (typeof rawContent === 'object') {
    // Neu la object attachment hoac structured data, giu nguyen cau truc khong bia dat
    return rawContent;
  }

  return String(rawContent);
}

/**
 * Chuan hoa 1 ban ghi tin nhan duy nhat
 * Khong bia dat cac truong thieu, tra ve null neu API khong cung cap.
 *
 * @param {Object} item - Doi tuong tin nhan (GroupMessage hoac object raw)
 * @param {string} [fallbackGroupId=null] - Group ID du phong neu tin nhan khong mang san
 * @returns {Object|null}
 */
export function normalizeMessage(item, fallbackGroupId = null) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  // Ho tro ca GroupMessage wrapper (co .data) va object raw
  const data = item.data && typeof item.data === 'object' ? item.data : item;

  // 1. Message ID
  const rawId = data.msgId ?? data.actionId ?? data.cliMsgId ?? null;
  const id = rawId !== null && rawId !== undefined ? String(rawId) : null;

  // 2. Group ID
  const rawGroupId = item.threadId ?? data.idTo ?? fallbackGroupId ?? null;
  const groupId = rawGroupId !== null && rawGroupId !== undefined ? String(rawGroupId) : null;

  // 3. Sender ID
  const rawSenderId = data.uidFrom ?? data.userId ?? null;
  const senderId = rawSenderId !== null && rawSenderId !== undefined ? String(rawSenderId) : null;

  // 4. Sender Name
  const senderName = data.dName || data.senderName || null;

  // 5. Content
  const content = normalizeContent(data.content);

  // 6. Timestamp
  const timestamp = normalizeTimestamp(data.ts);

  // 7. Message Type
  const type = data.msgType || (typeof item.type === 'string' ? item.type : null) || null;

  return {
    id,
    groupId,
    senderId,
    senderName,
    content,
    timestamp,
    type
  };
}

/**
 * Chuan hoa danh sach tin nhan, tu dong loai bo ban ghi trung lap, ban ghi khong hop le
 * va tu dong sap xep theo thoi gian (timestamp)
 *
 * @param {Array} rawMessages - Mang tin nhan tu API
 * @param {Object} options
 * @param {string} [options.groupId=null] - Group ID mac dinh
 * @param {boolean} [options.deduplicate=true] - Tu dong loai bo tin nhan trung ID
 * @param {'asc'|'desc'|null} [options.sortOrder='asc'] - 'asc' (cu den moi) hoac 'desc' (moi den cu)
 * @returns {Array<Object>} Mang tin nhan da chuan hoa
 */
export function normalizeMessages(rawMessages, options = {}) {
  const { groupId = null, deduplicate = true, sortOrder = 'asc' } = options;

  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const result = [];
  const seenIds = new Set();

  for (const rawItem of rawMessages) {
    const normalized = normalizeMessage(rawItem, groupId);
    if (!normalized) continue;

    if (deduplicate && normalized.id) {
      if (seenIds.has(normalized.id)) {
        continue; // Bo qua tin nhan trung ID
      }
      seenIds.add(normalized.id);
    }

    result.push(normalized);
  }

  // Sap xep tin nhan theo thoi gian
  if (sortOrder) {
    result.sort((a, b) => {
      const timeA = a.timestamp || 0;
      const timeB = b.timestamp || 0;
      return sortOrder === 'desc' ? timeB - timeA : timeA - timeB;
    });
  }

  return result;
}

/**
 * Tao payload day du de xuat JSON bao gom metadata
 *
 * @param {Array<Object>} messages - Danh sach tin nhan da chuan hoa
 * @param {Object} meta - Thong tin bo sung (groupInfo, count, v.v.)
 * @returns {Object}
 */
export function buildExportPayload(messages, meta = {}) {
  return {
    schemaVersion: '1.0.0',
    fetchedAt: new Date().toISOString(),
    group: {
      id: meta.groupId || null,
      name: meta.groupName || null
    },
    totalMessages: messages.length,
    messages
  };
}
