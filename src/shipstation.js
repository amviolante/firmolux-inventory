// ShipStation REST client for the reconcile job. Honours the 40 req/min
// per-key limit via the X-Rate-Limit-* headers.
const axios = require('axios');

const API_BASE = () => process.env.SHIPSTATION_API_BASE || 'https://ssapi.shipstation.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function shipStationClient({ apiKey, apiSecret }) {
  const http = axios.create({
    baseURL: API_BASE(),
    auth: { username: apiKey, password: apiSecret },
    timeout: 60000,
  });

  async function get(path, params) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await http.get(path, { params });
        const remaining = parseInt(res.headers['x-rate-limit-remaining'] || '40', 10);
        const reset = parseInt(res.headers['x-rate-limit-reset'] || '0', 10);
        if (remaining <= 2) await sleep((reset + 1) * 1000);
        return res.data;
      } catch (err) {
        if (err.response && err.response.status === 429) {
          const reset = parseInt(err.response.headers['x-rate-limit-reset'] || '30', 10);
          await sleep((reset + 1) * 1000);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`ShipStation ${path}: rate limited 5 times, giving up`);
  }

  async function getAll(path, params, listKey) {
    const out = [];
    for (let page = 1; ; page++) {
      const data = await get(path, { ...params, page, pageSize: 500 });
      out.push(...(data[listKey] || []));
      if (!data.pages || page >= data.pages) break;
    }
    return out;
  }

  return { get, getAll };
}

module.exports = { shipStationClient };
