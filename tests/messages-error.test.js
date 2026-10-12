import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGroupHistory } from '../src/messages.js';
import { fetchGroups } from '../src/groups.js';

describe('Unit Tests: API Error & Validation Handling', () => {
  describe('fetchGroupHistory', () => {
    test('nem loi ro rang khi api instance khong hop le hoac thieu getGroupChatHistory', async () => {
      await assert.rejects(
        async () => {
          await fetchGroupHistory(null, 'group-123');
        },
        /API instance khong hop le hoac thieu method getGroupChatHistory/
      );
    });

    test('nem loi khi groupId bi thieu hoac khong phai chuoi', async () => {
      const mockApi = {
        getGroupChatHistory: async () => ({})
      };

      await assert.rejects(
        async () => {
          await fetchGroupHistory(mockApi, null);
        },
        /groupId la bat buoc va phai la kieu chuoi/
      );
    });

    test('xu ly khi getGroupChatHistory nem loi tu backend ma khong ro ri thong tin nhay cam', async () => {
      const mockApi = {
        getGroupChatHistory: async () => {
          const err = new Error('Request failed with status code 404');
          err.status = 404;
          throw err;
        }
      };

      try {
        await fetchGroupHistory(mockApi, 'group-123', 10);
        assert.fail('Ham phai nem loi');
      } catch (err) {
        assert.match(err.message, /Loi khi goi getGroupChatHistory/);
        assert.equal(err.details?.code, 404);
        assert.equal(err.details?.package, 'zca-js@2.2.0');
        assert.equal(err.details?.method, 'api.getGroupChatHistory');
      }
    });

    test('xu ly thanh cong khi API tra ve du lieu va phan trang (pagination flags)', async () => {
      const mockApi = {
        getGroupChatHistory: async (gid, count) => ({
          lastActionId: 'act-999',
          lastActionIdOther: 'act-other-888',
          more: 1,
          groupMsgs: [
            {
              data: {
                msgId: 'm1',
                idTo: gid,
                uidFrom: 'u1',
                content: 'Test msg',
                ts: '1712345678000'
              }
            }
          ]
        })
      };

      const result = await fetchGroupHistory(mockApi, 'group-123', 5);
      assert.equal(result.messages.length, 1);
      assert.equal(result.pagination.lastActionId, 'act-999');
      assert.equal(result.pagination.hasMore, true);
    });
  });

  describe('fetchGroups', () => {
    test('nem loi khi api instance thieu getAllGroups', async () => {
      await assert.rejects(
        async () => {
          await fetchGroups({});
        },
        /API instance khong hop le hoac thieu method getAllGroups/
      );
    });

    test('xu ly response rong khi tai khoan khong co nhom nao', async () => {
      const mockApi = {
        getAllGroups: async () => ({
          version: '1',
          gridVerMap: {}
        })
      };

      const result = await fetchGroups(mockApi);
      assert.deepEqual(result.groups, []);
      assert.deepEqual(result.raw.allGroups, { version: '1', gridVerMap: {} });
    });
  });
});
