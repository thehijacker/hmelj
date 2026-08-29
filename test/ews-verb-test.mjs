// The EWS half, tested against realistic response XML — the real Exchange
// account can't be part of an automated test, so the parse and the generated
// UpdateItem XML are checked directly instead.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server/ewsClient.js', import.meta.url), 'utf8');
let pass=0, fail=0;
const ok=(c,m,e='')=>{ if(c){pass++;console.log('  ✓ '+m);} else {fail++;console.log('  ✗ '+m+(e?' — '+e:''));} };

// Same parser configuration ewsClient.js uses.
const xmlParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true,
  isArray: (n) => ['Folder','Message','Mailbox','ExtendedProperty','FindFolderResponseMessage','GetFolderResponseMessage','FindItemResponseMessage','GetItemResponseMessage'].includes(n),
});

// The two functions under test, lifted verbatim from the module (they are
// module-private; copying them keeps the test honest only as long as it stays
// in sync — asserted below).
const VERB_TAG='0x1081', VERB={REPLY:102,REPLY_ALL:103,FORWARD:104};
const asArray=(v)=>v==null?[]:(Array.isArray(v)?v:[v]);
function extendedProp(item, tag){ const want=Number(tag); for(const p of asArray(item?.ExtendedProperty)){ if(Number(p?.ExtendedFieldURI?.['@_PropertyTag'])===want) return p.Value; } return undefined; }
function verbState(item){ const v=Number(extendedProp(item,VERB_TAG)); return { answered: v===VERB.REPLY||v===VERB.REPLY_ALL, forwarded: v===VERB.FORWARD }; }
ok(src.includes("if (Number(p?.ExtendedFieldURI?.['@_PropertyTag']) === want) return p.Value;"), 'extendedProp copy still matches the module');
ok(src.includes('answered: v === VERB.REPLY || v === VERB.REPLY_ALL,'), 'verbState copy still matches the module');

const item = (propXml) => xmlParser.parse(
  `<t:Message xmlns:t="x"><t:Subject>s</t:Subject><t:IsRead>true</t:IsRead>${propXml}</t:Message>`).Message[0];
const prop = (tag, val) => `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="${tag}" PropertyType="Integer"/><t:Value>${val}</t:Value></t:ExtendedProperty>`;

console.log('reading PidTagLastVerbExecuted');
ok(JSON.stringify(verbState(item(''))) === '{"answered":false,"forwarded":false}', 'no property at all = neither (the common case)');
ok(verbState(item(prop('0x1081', 102))).answered === true, 'verb 102 (reply) reads as answered');
ok(verbState(item(prop('0x1081', 103))).answered === true, 'verb 103 (reply-all) also reads as answered');
ok(verbState(item(prop('0x1081', 104))).forwarded === true, 'verb 104 reads as forwarded');
ok(verbState(item(prop('4225', 104))).forwarded === true, 'a DECIMAL tag echo (4225) is matched too');
ok(verbState(item(prop('0x1090', 2))).answered === false, 'a different property (FlagStatus) is not mistaken for it');
ok(verbState(item(prop('0x1090', 2) + prop('0x1081', 102))).answered === true, 'found among several properties');

console.log('\ngenerated UpdateItem XML');
const escXml=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const uri=(tag,type)=>`<t:ExtendedFieldURI PropertyTag="${tag}" PropertyType="${type}"/>`;
const field=(tag,type,value)=>`<t:SetItemField>${uri(tag,type)}<t:Message><t:ExtendedProperty>${uri(tag,type)}<t:Value>${escXml(value)}</t:Value></t:ExtendedProperty></t:Message></t:SetItemField>`;
const xml = field('0x1081','Integer',102) + field('0x1082','SystemTime', new Date().toISOString().replace(/\.\d{3}Z$/,'Z'));
ok(XMLValidator.validate(`<r xmlns:t="x">${xml}</r>`) === true, 'the SetItemField fragment is well-formed XML');
const back = xmlParser.parse(`<r xmlns:t="x">${xml}</r>`).r.SetItemField;
ok(Number(back[0].Message[0].ExtendedProperty[0].Value) === 102, 'it round-trips back to verb 102');
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(back[1].Message[0].ExtendedProperty[0].Value)),
   'the timestamp is in EWS SystemTime format (no milliseconds)', String(back[1].Message[0].ExtendedProperty[0].Value));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
