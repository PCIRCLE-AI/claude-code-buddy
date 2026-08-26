import { fetchAgentMessage, pollAgentEvents, readAgentMessageReceipts, recordAgentReceipt, sendAgentMessage, waitForAgentEvents, } from '../core/agent-messaging.js';
import { MessageSchema } from './schemas.js';
function receiptDetail(note, context) {
    return {
        transport: context.transport,
        source_host: context.sourceHost,
        ...(note ? { note } : {}),
    };
}
export async function executeAgentMessageAction(db, rawInput, context) {
    const input = MessageSchema.parse(rawInput);
    switch (input.action) {
        case 'send':
            return sendAgentMessage(db, {
                project: input.project,
                sender: input.sender,
                sender_host: context.sourceHost,
                recipient: input.recipient,
                idempotency_key: input.idempotency_key,
                payload: input.payload,
                content_type: input.content_type,
                privacy: input.privacy,
                correlation_id: input.correlation_id,
                reply_to: input.reply_to,
                provenance: {
                    transport: context.transport,
                    source_host: context.sourceHost,
                },
            });
        case 'poll': {
            const query = {
                project: input.project,
                recipient: input.recipient,
                cursor: input.cursor,
                limit: input.limit,
            };
            return input.wait_ms > 0
                ? waitForAgentEvents(db, { ...query, wait_ms: input.wait_ms }, context.signal)
                : pollAgentEvents(db, query);
        }
        case 'fetch':
            return fetchAgentMessage(db, input);
        case 'intake':
            return recordAgentReceipt(db, {
                project: input.project,
                recipient: input.recipient,
                message_id: input.message_id,
                actor: input.recipient,
                idempotency_key: input.idempotency_key,
                receipt_kind: 'intake',
                intake_state: input.intake_state,
                detail: receiptDetail(undefined, context),
            });
        case 'ack':
            return recordAgentReceipt(db, {
                project: input.project,
                recipient: input.recipient,
                message_id: input.message_id,
                actor: input.recipient,
                idempotency_key: input.idempotency_key,
                receipt_kind: 'ack',
                detail: receiptDetail(undefined, context),
            });
        case 'disposition':
            return recordAgentReceipt(db, {
                project: input.project,
                recipient: input.recipient,
                message_id: input.message_id,
                actor: input.recipient,
                idempotency_key: input.idempotency_key,
                receipt_kind: 'disposition',
                disposition: input.disposition,
                detail: receiptDetail(input.detail, context),
            });
        case 'activation':
            return recordAgentReceipt(db, {
                project: input.project,
                recipient: input.recipient,
                message_id: input.message_id,
                actor: input.recipient,
                idempotency_key: input.idempotency_key,
                receipt_kind: 'host_activation',
                host_activation: input.activation,
                detail: receiptDetail(input.detail, context),
            });
        case 'receipts':
            return readAgentMessageReceipts(db, input);
    }
}
//# sourceMappingURL=agent-messaging.js.map