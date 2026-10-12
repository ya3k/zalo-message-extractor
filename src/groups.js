/**
 * Module quan ly va truy xuat danh sach nhom Zalo
 */

/**
 * Lay danh sach tat ca cac nhom ma tai khoan tham gia
 * @param {import('zca-js').API} api
 * @returns {Promise<{ raw: Object, groups: Array<{ id: string, name: string, memberCount: number }> }>}
 */
export async function fetchGroups(api) {
  if (!api || typeof api.getAllGroups !== 'function') {
    throw new Error('API instance khong hop le hoac thieu method getAllGroups');
  }

  // 1. Goi API lay danh sach ID nhom
  const rawGroupsResponse = await api.getAllGroups();
  const gridVerMap = rawGroupsResponse?.gridVerMap || {};
  const groupIds = Object.keys(gridVerMap);

  if (groupIds.length === 0) {
    return {
      raw: {
        allGroups: rawGroupsResponse,
        groupDetails: null
      },
      groups: []
    };
  }

  // 2. Goi API lay thong tin chi tiet (ten, so thanh vien, v.v.)
  let infoResponse = null;
  try {
    infoResponse = await api.getGroupInfo(groupIds);
  } catch (err) {
    console.warn(`[Groups] Khong the lay thong tin chi tiet nhom: ${err.message}`);
  }

  const gridInfoMap = infoResponse?.gridInfoMap || {};

  const groups = groupIds.map((groupId) => {
    const detail = gridInfoMap[groupId];
    return {
      id: groupId,
      name: detail?.name || `Nhom-${groupId}`,
      memberCount: detail?.totalMember || (Array.isArray(detail?.memberIds) && detail.memberIds.length) || 0
    };
  });

  return {
    raw: {
      allGroups: rawGroupsResponse,
      groupDetails: infoResponse
    },
    groups
  };
}
