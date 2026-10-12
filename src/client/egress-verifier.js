/**
 * Module xác minh địa chỉ IP egress cho tài khoản
 */

/**
 * @typedef {Object} EgressVerificationResult
 * @property {boolean} verified - Có thực hiện kiểm tra thành công hay không
 * @property {string|null} currentIp - IP egress thực tế đo được
 * @property {string|null} expectedIp - IP cố định được cấu hình kỳ vọng
 * @property {boolean} matchesExpected - IP thực tế có khớp với IP kỳ vọng hay không
 * @property {string} details - Thông tin tóm tắt kết quả
 */

/**
 * Kiểm tra IP egress thực tế của tiến trình hoặc qua proxy
 * @param {Object} egressConfig
 * @param {string|null} [egressConfig.expectedIp=null]
 * @param {string|null} [egressConfig.proxyUrl=null]
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<EgressVerificationResult>}
 */
export async function verifyEgressIp(egressConfig = {}, timeoutMs = 8000) {
  const { expectedIp = null, proxyUrl = null } = egressConfig;

  const ipEndpoints = [
    'https://api.ipify.org?format=json',
    'https://icanhazip.com'
  ];

  let detectedIp = null;
  let lastError = null;

  for (const endpoint of ipEndpoints) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const fetchOptions = {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ZaloIngestionWorker/1.0'
        }
      };

      const res = await fetch(endpoint, fetchOptions);
      clearTimeout(timeoutId);

      if (res.ok) {
        const text = (await res.text()).trim();
        if (text.startsWith('{')) {
          const json = JSON.parse(text);
          detectedIp = json.ip || null;
        } else {
          detectedIp = text;
        }
        if (detectedIp) break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (!detectedIp) {
    return {
      verified: false,
      currentIp: null,
      expectedIp,
      matchesExpected: false,
      details: `Không thể kết nối đến dịch vụ kiểm tra IP egress: ${lastError?.message || 'Timeout'}`
    };
  }

  const matchesExpected = expectedIp ? detectedIp === expectedIp : true;

  return {
    verified: true,
    currentIp: detectedIp,
    expectedIp,
    matchesExpected,
    details: expectedIp
      ? matchesExpected
        ? `IP egress khớp chính xác với cấu hình cố định (${detectedIp}).`
        : `CẢNH BÁO: IP egress thực tế (${detectedIp}) KHÔNG khớp với IP kỳ vọng (${expectedIp})!`
      : `IP egress quan sát được: ${detectedIp} (không cấu hình IP cố định).`
  };
}
