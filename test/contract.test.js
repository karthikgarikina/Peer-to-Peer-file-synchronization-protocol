const { PactV3, MatchersV3 } = require('@pact-foundation/pact');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { expect } = require('chai');

const { like, string, integer, eachLike } = MatchersV3;

const provider = new PactV3({
  consumer: 'NodeA',
  provider: 'NodeB',
  dir: path.resolve(process.cwd(), 'pacts'),
});

describe('Metadata API Contract', () => {

  let testFilePath;
  let testFileDir;

  before(() => {
    testFileDir = path.resolve(__dirname, '../sync_dir_test');
    if (!fs.existsSync(testFileDir)) {
      fs.mkdirSync(testFileDir, { recursive: true });
    }
    testFilePath = path.join(testFileDir, 'test.txt');
    fs.writeFileSync(testFilePath, 'hello pact');
  });

  after(() => {
    try {
      fs.unlinkSync(testFilePath);
      fs.rmdirSync(testFileDir);
    } catch (e) {}
  });

  // ── GET /files/{filepath}/metadata - 200 OK ──────────────────────────────
  it('provides the correct metadata for a file', () => {
    const expectedBody = {
      filePath: string('test.txt'),
      size: integer(10),
      modified_at: string('2023-10-27T10:00:00.000Z'),
      full_hash: string('abc123'),
      block_size: integer(1024),
      blocks: eachLike({
        index: integer(0),
        weak_hash: integer(12345),
        strong_hash: string('sha256hash'),
      }),
    };

    return provider
      .given('a file exists')
      .uponReceiving('a request for file metadata')
      .withRequest({
        method: 'GET',
        path: '/files/test.txt/metadata',
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: expectedBody,
      })
      .executeTest(async (mockServer) => {
        const response = await axios.get(`${mockServer.url}/files/test.txt/metadata`);
        expect(response.status).to.equal(200);
        expect(response.data).to.have.property('filePath');
        expect(response.data).to.have.property('size');
        expect(response.data).to.have.property('full_hash');
        expect(response.data).to.have.property('block_size');
        expect(response.data).to.have.property('blocks');
        expect(response.data.blocks).to.be.an('array');
      });
  });

  // ── GET /files/{filepath}/metadata - 404 Not Found ────────────────────────
  it('returns 404 for a non-existent file', () => {
    return provider
      .given('no file exists')
      .uponReceiving('a request for non-existent file metadata')
      .withRequest({
        method: 'GET',
        path: '/files/nonexistent.txt/metadata',
      })
      .willRespondWith({
        status: 404,
      })
      .executeTest(async (mockServer) => {
        try {
          await axios.get(`${mockServer.url}/files/nonexistent.txt/metadata`);
          throw new Error('Should have thrown 404');
        } catch (e) {
          expect(e.response.status).to.equal(404);
        }
      });
  });

  // ── PATCH /files/{filepath} - 200 OK ──────────────────────────────────────
  it('accepts a file patch and returns success', () => {
    return provider
      .given('a file can be patched')
      .uponReceiving('a request to patch a file')
      .withRequest({
        method: 'PATCH',
        path: '/files/test.txt',
        headers: { 'Content-Type': 'application/json' },
        body: {
          base_full_hash: string('abc123'),
          patches: eachLike({
            type: 'new_block',
            index: integer(0),
            byte_index: integer(0),
            data: string('aGVsbG8='),
          }),
          final_full_hash: string('def456'),
        },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: {
          status: string('success'),
        },
      })
      .executeTest(async (mockServer) => {
        const response = await axios.patch(`${mockServer.url}/files/test.txt`, {
          base_full_hash: 'somehash',
          patches: [{ type: 'new_block', index: 0, byte_index: 0, data: 'aGVsbG8=' }],
          final_full_hash: 'anotherhash',
        });
        expect(response.status).to.equal(200);
        expect(response.data.status).to.equal('success');
      });
  });
});
