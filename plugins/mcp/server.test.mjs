import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, selectSpaces, validateConfig } from './server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer as httpServer } from 'node:http';

const config = {url:'https://wall.example.com',user:'owner',spaces:['Inbox','Backlog'],token:'sw_read_test'};
const spaces = [{id:'i',name:'Inbox',isInbox:true},{id:'b',name:'Backlog'},{id:'p',name:'Private'}];
test('configuration fails closed for wrong user, missing/ambiguous spaces, empty scopes and non-TLS remote URLs', () => {
  assert.deepEqual(selectSpaces(config,{user:{subject:'owner'},spaces}).map(s => s.id),['i','b']);
  assert.throws(() => selectSpaces(config,{user:{subject:'other'},spaces}));
  assert.throws(() => selectSpaces(config,{user:{subject:'owner'},spaces:spaces.slice(0,1)}));
  assert.throws(() => selectSpaces(config,{user:{subject:'owner'},spaces:[...spaces,{id:'another',name:'Inbox'}]}));
  assert.throws(() => validateConfig({...config,spaces:[]}));
  assert.throws(() => validateConfig({...config,spaces:['*','Inbox']}));
  assert.throws(() => validateConfig({...config,url:'http://wall.example.com'}));
  assert.equal(selectSpaces({...config,spaces:['*']},{user:{subject:'owner'},spaces}).length,3);
});

test('MCP advertises current spaces, reads/searches with pagination, rejects unknown scopes and prompts safely', async () => {
  const requests = [];
  const http = httpServer((req,res) => {
    assert.equal(req.headers.authorization,'Bearer sw_read_test');
    const u = new URL(req.url,'http://localhost'); requests.push(u);
    res.setHeader('content-type','application/json');
    if (u.pathname.endsWith('/context')) res.end(JSON.stringify({user:{subject:'owner',displayName:'Owner'},spaces}));
    else if (u.pathname.endsWith('/memos/private-memo')) res.end(JSON.stringify({id:'private-memo',spaceId:'p',body:'hidden'}));
    else if (u.pathname.endsWith('/memos/memo')) res.end(JSON.stringify({id:'memo',spaceId:'b',body:'read me',attachments:[]}));
    else {
      const offset = Number(u.searchParams.get('offset'));
      const space = u.searchParams.get('spaceId');
      res.end(JSON.stringify({memos:[{id:`${space}-${offset}`,spaceId:space,body:'task'}],nextOffset:offset===0?1:null}));
    }
  });
  await new Promise(r => http.listen(0,'127.0.0.1',r));
  const server = await createServer({...config,url:`http://127.0.0.1:${http.address().port}`});
  const client = new Client({name:'test',version:'1'});
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length,4);
    assert.ok(tools.tools.every(t => t.description.includes('Inbox') && t.description.includes('Backlog')));
    const list = await client.callTool({name:'scratchwall_list_spaces',arguments:{}});
    assert.equal(list.structuredContent.spaces.length,2);
    const read = await client.callTool({name:'scratchwall_read_space',arguments:{space:'backlog',limit:1}});
    assert.equal(read.structuredContent.space.id,'b'); assert.equal(read.structuredContent.nextOffset,1);
    const invalid = await client.callTool({name:'scratchwall_read_space',arguments:{space:'Private'}});
    assert.equal(invalid.isError,true);
    const invalidMemo = await client.callTool({name:'scratchwall_get_memo',arguments:{id:'private-memo'}});
    assert.equal(invalidMemo.isError,true); assert.ok(!JSON.stringify(invalidMemo).includes('hidden'));
    const first = await client.callTool({name:'scratchwall_search_memos',arguments:{query:'task',limit:1}});
    assert.ok(first.structuredContent.cursor);
    const next = await client.callTool({name:'scratchwall_search_memos',arguments:{query:'task',limit:1,cursor:first.structuredContent.cursor}});
    assert.equal(next.structuredContent.memos[0].id,'i-1');
    const stale = await client.callTool({name:'scratchwall_search_memos',arguments:{query:'changed',cursor:first.structuredContent.cursor}});
    assert.equal(stale.isError,true);
    const prompt = await client.getPrompt({name:'check_scratchwall',arguments:{space:'Backlog'}});
    assert.ok(prompt.messages[0].content.text.includes('ID b'));
    assert.ok(!requests.filter(u=>u.pathname.endsWith('/memos')).some(u=>u.searchParams.get('spaceId')==='p'));
  } finally { await client.close(); await server.close(); await new Promise(r=>http.close(r)); }
});
