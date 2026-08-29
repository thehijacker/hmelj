# Context: Exchange Web Services (EWS) Node.js Integration Guide

This document defines the working authentication mechanism and SOAP schema requirements for interacting with the local Exchange 2013 server via Node.js. Use this specification to build the backend service for the email client.

---

## 1. Environment & Authentication Protocol

* **Exchange Host:** `https://e2k13.domain.com/EWS/Exchange.asmx`
* **Target Version:** `Exchange2013`
* **Authentication Method:** NTLM v1/v2 over HTTPS.
* **Transport Driver:** `httpntlm` (npm package). Standard libraries like `ews-javascript-api` or `node-ews` fail NTLM handshake on Node v22+ and must **not** be used.
* **TLS Configuration:** Certificate validation is disabled for local testing: `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'`.

### Verified Connection Setup

```javascript
const httpntlm = require('httpntlm');

const config = {
  url: 'https://e2k13.domain.com/EWS/Exchange.asmx',
  username: 'username',
  password: 'password',
  domain: 'domain',
  workstation: ''
};

function sendEwsRequest(soapAction, soapBody) {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2013" />
  </soap:Header>
  <soap:Body>
    ${soapBody}
  </soap:Body>
</soap:Envelope>`;

    httpntlm.post({
      url: config.url,
      username: config.username,
      password: config.password,
      domain: config.domain,
      workstation: config.workstation,
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': `http://schemas.microsoft.com/exchange/services/2006/messages/${soapAction}`
      },
      body: envelope
    }, (err, res) => {
      if (err) return reject(err);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${res.body}`));
      resolve(res.body);
    });
  });
}
```

---

## 2. Core Operational Payloads

Every item in EWS requires both `ItemId.Id` and `ItemId.ChangeKey` for modifications.

### List Folders (`FindFolder`)

Returns child folders for a designated parent folder (`inbox`, `root`, `msgfolderroot`).

```xml
<m:FindFolder Traversal="Shallow">
  <m:FolderShape>
    <t:BaseShape>Default</t:BaseShape>
  </m:FolderShape>
  <m:ParentFolderIds>
    <t:DistinguishedFolderId Id="root" />
  </m:ParentFolderIds>
</m:FindFolder>
```

### List Messages (`FindItem`)

Fetches message headers with pagination and sorting.

```xml
<m:FindItem Traversal="Shallow">
  <m:ItemShape>
    <t:BaseShape>IdOnly</t:BaseShape>
    <t:AdditionalProperties>
      <t:FieldURI FieldURI="item:Subject" />
      <t:FieldURI FieldURI="message:From" />
      <t:FieldURI FieldURI="item:DateTimeReceived" />
      <t:FieldURI FieldURI="message:IsRead" />
      <t:FieldURI FieldURI="item:Importance" />
      <t:FieldURI FieldURI="item:Flag" />
      <t:FieldURI FieldURI="item:HasAttachments" />
    </t:AdditionalProperties>
  </m:ItemShape>
  <m:IndexedPageItemView MaxEntriesReturned="20" Offset="0" BasePoint="Beginning" />
  <m:SortOrder>
    <t:FieldOrder Order="Descending">
      <t:FieldURI FieldURI="item:DateTimeReceived" />
    </t:FieldOrder>
  </m:SortOrder>
  <m:ParentFolderIds>
    <t:DistinguishedFolderId Id="inbox" /> <!-- Or use <t:FolderId Id="FOLDER_ID"/> -->
  </m:ParentFolderIds>
</m:FindItem>
```

### Fetch Full Message Body (`GetItem`)

Retrieves full HTML or Text body and attachment metadata.

```xml
<m:GetItem>
  <m:ItemShape>
    <t:BaseShape>Default</t:BaseShape>
    <t:BodyType>HTML</t:BodyType>
    <t:AdditionalProperties>
      <t:FieldURI FieldURI="item:Attachments" />
    </t:AdditionalProperties>
  </m:ItemShape>
  <m:ItemIds>
    <t:ItemId Id="ITEM_ID" ChangeKey="CHANGE_KEY" />
  </m:ItemIds>
</m:GetItem>
```

### Mark Read / Unread (`UpdateItem`)

```xml
<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
  <m:ItemChanges>
    <t:ItemChange>
      <t:ItemId Id="ITEM_ID" ChangeKey="CHANGE_KEY" />
      <t:Updates>
        <t:SetItemField>
          <t:FieldURI FieldURI="message:IsRead" />
          <t:Message>
            <t:IsRead>true</t:IsRead> <!-- set to false for unread -->
          </t:Message>
        </t:SetItemField>
      </t:Updates>
    </t:ItemChange>
  </m:ItemChanges>
</m:UpdateItem>
```

### Star / Flag Message (`UpdateItem`)

Exchange uses the `FlagStatus` property to control stars/flags.

```xml
<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
  <m:ItemChanges>
    <t:ItemChange>
      <t:ItemId Id="ITEM_ID" ChangeKey="CHANGE_KEY" />
      <t:Updates>
        <t:SetItemField>
          <t:FieldURI FieldURI="item:Flag" />
          <t:Message>
            <t:Flag>
              <t:FlagStatus>Flagged</t:FlagStatus> <!-- Options: Flagged, Complete, NotFlagged -->
            </t:Flag>
          </t:Message>
        </t:SetItemField>
      </t:Updates>
    </t:ItemChange>
  </m:ItemChanges>
</m:UpdateItem>
```

### Delete Message (`DeleteItem`)

* `SoftDelete`: Moves message to `deleteditems`.
* `HardDelete`: Permanently purges message.

```xml
<m:DeleteItem DeleteType="SoftDelete">
  <m:ItemIds>
    <t:ItemId Id="ITEM_ID" ChangeKey="CHANGE_KEY" />
  </m:ItemIds>
</m:DeleteItem>
```

### Move Message (`MoveItem`)

```xml
<m:MoveItem>
  <m:ToFolderId>
    <t:DistinguishedFolderId Id="deleteditems" /> <!-- Or <t:FolderId Id="TARGET_FOLDER_ID"/> -->
  </m:ToFolderId>
  <m:ItemIds>
    <t:ItemId Id="ITEM_ID" ChangeKey="CHANGE_KEY" />
  </m:ItemIds>
</m:MoveItem>
```

### Send New Email (`CreateItem`)

```xml
<m:CreateItem MessageDisposition="SendAndSaveCopy">
  <m:Items>
    <t:Message>
      <t:Subject>Subject Line</t:Subject>
      <t:Body BodyType="HTML">HTML or Plain text body content</t:Body>
      <t:ToRecipients>
        <t:Mailbox>
          <t:EmailAddress>recipient@domain.com</t:EmailAddress>
        </t:Mailbox>
      </t:ToRecipients>
    </t:Message>
  </m:Items>
</m:CreateItem>
```

### Reply & Reply All (`CreateItem`)

```xml
<m:CreateItem MessageDisposition="SendAndSaveCopy">
  <m:Items>
    <t:ReplyToItem> <!-- Use ReplyAllToItem for Reply All -->
      <t:ReferenceItemId Id="ITEM_ID" ChangeKey="CHANGE_KEY" />
      <t:NewBodyContent BodyType="HTML">Your reply message content here.</t:NewBodyContent>
    </t:ReplyToItem>
  </m:Items>
</m:CreateItem>
```

### Forward Message (`CreateItem`)

```xml
<m:CreateItem MessageDisposition="SendAndSaveCopy">
  <m:Items>
    <t:ForwardItem>
      <t:ReferenceItemId Id="ITEM_ID" ChangeKey="CHANGE_KEY" />
      <t:ToRecipients>
        <t:Mailbox>
          <t:EmailAddress>forward_target@domain.com</t:EmailAddress>
        </t:Mailbox>
      </t:ToRecipients>
      <t:NewBodyContent BodyType="HTML">Forward note message content here.</t:NewBodyContent>
    </t:ForwardItem>
  </m:Items>
</m:CreateItem>
```

---

## 3. Advanced EWS Capabilities to Implement

* **Folder Management (`CreateFolder`, `DeleteFolder`, `MoveFolder`):** Dynamically build custom directory trees.
* **Attachment Handling (`GetAttachment`, `CreateAttachment`):** Fetch binary streams encoded as Base64 strings from Exchange items.
* **Server-Side Search (`FindItem` with `Restriction`):** Execute targeted queries by sender, date range, or subject text directly on the Exchange engine:
  ```xml
  <m:Restriction>
    <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
      <t:FieldURI FieldURI="item:Subject" />
      <t:Constant Value="search term" />
    </t:Contains>
  </m:Restriction>
  ```
* **Streaming Notifications / Subscriptions (`Subscribe`, `GetStreamingEvents`):** Push real-time updates to the web client UI over WebSockets when new emails arrive.
* **Out of Office (OOF) Settings (`GetUserOofSettings`, `SetUserOofSettings`):** Read and toggle automatic out-of-office responses.
