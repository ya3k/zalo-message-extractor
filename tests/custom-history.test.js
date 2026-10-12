import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerCustomHistory, fetchGroupHistoryV2 } from '../src/custom-history.js';

describe('Unit Tests: Custom History V2 (Cloud Endpoint)', () => {
  test('dang ky method getGroupChatHistoryV2 tren api instance qua api.custom', () => {
    let registeredName = null;
    let registeredCallback = null;

    const mockApi = {
      custom: (name, cb) => {
        registeredName = name;
        registeredCallback = cb;
        mockApi[name] = (props) => cb({
          ctx: { uid: '123', imei: 'mock-imei' },
          utils: {
            makeURL: (url) => url,
            encodeAES: () => 'encrypted',
            request: async () => ({ status: 200 }),
            resolve: async () => ({ groupMsgs: [] })
          },
          props
        });
      }
    };

    registerCustomHistory(mockApi);
    assert.equal(registeredName, 'getGroupChatHistoryV2');
    assert.equal(typeof mockApi.getGroupChatHistoryV2, 'function');
  });

  test('fetchGroupHistoryV2 tra ve danh sach tin nhan va pagination', async () => {
    const mockApi = {
      zpwServiceMap: {
        group_cloud_message: ['https://mock.zalo.me']
      },
      custom: (name, cb) => {
        mockApi[name] = (props) => cb({
          ctx: { uid: 'u-self', imei: 'imei-123' },
          utils: {
            makeURL: (url, query) => url,
            encodeAES: (data) => 'encrypted-' + data,
            request: async () => ({ status: 200 }),
            resolve: async (res, transform) => {
              const data = {
                lastMsgId: 100,
                hasMore: false,
                groupMsgs: [
                  {
                    msgId: 'msg-1',
                    idTo: 'group-1',
                    uidFrom: 'u-from',
                    content: 'Hello V2 Cloud',
                    ts: '1712345678000'
                  }
                ]
              };
              return transform({ data });
            }
          },
          props
        });
      }
    };

    const result = await fetchGroupHistoryV2(mockApi, 'group-1', 5);
    assert.equal(result.messages.length, 1);
    assert.equal(result.pagination.hasMore, false);
    assert.equal(result.pagination.lastMsgId, 100);
  });
});
