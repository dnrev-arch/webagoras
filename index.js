const express = require('express');
const axios = require('axios');
const app = express();

// ============ CONFIGURAÇÕES PERSONALIZADAS DANILO ============
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/kirvano-pag';
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'https://danilo-danilo-atendimento-n8n.jq3pgw.easypanel.host/webhook/evolution';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos (conforme solicitado)
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos
const DATA_RETENTION = 24 * 60 * 60 * 1000; // 24 horas
const IDEMPOTENCY_TTL = 5 * 60 * 1000; // 5 minutos
const PORT = process.env.PORT || 3000;

// ============ MAPEAMENTO DE PRODUTOS DANILO (OFFER_ID) ============
const PRODUCT_MAPPING = {
    // FAB - 2 checkouts ativos
    '668a73bc-2fca-4f12-9331-ef945181cd5c': 'FAB',
    '69f801e6-a26e-42bb-aa38-89e2767b489f': 'FAB',
    
    // CS - 3 produtos
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS',
    '564bb9bb-718a-4e8b-a843-a2da62f616f0': 'CS',
    
    // NAT - 3 produtos
    '08be89d4-96a7-40fd-9d32-ecc4b5cffcdb': 'NAT',
    '4230eda0-4762-47e6-b8e7-72ab8a2f6f90': 'NAT',
    'f2289442-c3bc-415f-b6bd-5bc3c3e8e2f7': 'NAT'
};

// ============ INSTÂNCIAS DANILO (D01-D10) ============
const INSTANCES = [
    { name: 'D01', id: 'E72041FBC017-4C78-B82B-A0D90F95FE5F', phone: '557582237133' },
    { name: 'D03', id: '6B605CD2B735-4A89-A914-7E9508B7481B', phone: '557587077646' },
    { name: 'D04', id: 'F13E2FF90F39-4DC7-8D0D-FDB1395B4546', phone: '557587002116' },
    { name: 'D05', id: '3775095A36FB-43C4-AA9C-5335D120F466', phone: '557587092975' },
    { name: 'D06', id: 'F27A6A27213E-40C3-A334-F3A2261E3631', phone: '555481007975' },
    { name: 'D07', id: '0082AB570022-4AE3-95ED-031DA35DAA30', phone: '557587053003' },
    { name: 'D08', id: 'DEB1AB14A0FF-4D98-8F60-D5341D239EBC', phone: '557582253844' },
    { name: 'D10', id: '2EFC39376BAD-43F8-A6E8-61349EEFAAD3', phone: '557587092976' }
];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let pixTimeouts = new Map();        // Timeouts de PIX por telefone
let conversationState = new Map();  // Estado das conversas
let clientInstanceMap = new Map();  // Cliente -> Instância (sticky)
let idempotencyCache = new Map();   // Cache de idempotência
let instanceCounter = 0;
let eventHistory = [];              // Histórico de eventos das últimas 24h

app.use(express.json());

// ============ FUNÇÕES AUXILIARES ============

// Normalizar número de telefone (mantém o 9º dígito)
function normalizePhone(phone) {
    if (!phone) return '';
    
    let cleaned = phone.replace(/\D/g, '');
    
    // Se tem 10 ou 11 dígitos (formato local), adiciona 55
    if (cleaned.length === 10 || cleaned.length === 11) {
        cleaned = '55' + cleaned;
    }
    
    // Se não começa com 55, adiciona
    if (!cleaned.startsWith('55')) {
        cleaned = '55' + cleaned;
    }
    
    console.log(`📱 Normalização: ${phone} → ${cleaned}`);
    return cleaned;
}

// Verificar se evento é aprovado (baseado nos dados da Kirvano)
function isApprovedEvent(event, status) {
    return event === 'SALE_APPROVED' && status === 'APPROVED';
}

// Verificar se é PIX pendente (baseado nos dados da Kirvano)
function isPendingPixEvent(event, status) {
    return event === 'PIX_GENERATED' && status === 'PENDING';
}

// Extrair texto de mensagem Evolution (múltiplos formatos)
function extractMessageText(message) {
    if (!message) return '';
    
    // Texto simples
    if (message.conversation) return message.conversation;
    
    // Texto estendido
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    
    // Legenda de imagem/vídeo
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    
    // Resposta de botão
    if (message.buttonsResponseMessage?.selectedDisplayText) 
        return message.buttonsResponseMessage.selectedDisplayText;
    
    // Resposta de lista
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
        return message.listResponseMessage.singleSelectReply.selectedRowId;
    
    // Template button
    if (message.templateButtonReplyMessage?.selectedId)
        return message.templateButtonReplyMessage.selectedId;
    
    return '';
}

// Verificar idempotência
function checkIdempotency(key) {
    const now = Date.now();
    
    // Limpar cache antigo
    for (const [k, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > IDEMPOTENCY_TTL) {
            idempotencyCache.delete(k);
        }
    }
    
    // Verificar se já existe
    if (idempotencyCache.has(key)) {
        console.log(`🔁 Evento duplicado ignorado: ${key}`);
        return true;
    }
    
    // Adicionar ao cache
    idempotencyCache.set(key, now);
    return false;
}

// Obter próxima instância (round-robin simples)
function getNextInstanceForClient(phone) {
    const normalized = normalizePhone(phone);
    
    // Se já tem instância atribuída, mantém a mesma
    if (clientInstanceMap.has(normalized)) {
        const assigned = clientInstanceMap.get(normalized);
        console.log(`✅ Cliente ${normalized} mantido em ${assigned.instance}`);
        return assigned.instance;
    }
    
    // Atribui próxima instância na sequência
    const instance = INSTANCES[instanceCounter % INSTANCES.length];
    instanceCounter++;
    
    // Salvar mapeamento
    clientInstanceMap.set(normalized, {
        instance: instance.name,
        createdAt: new Date()
    });
    
    console.log(`✅ Cliente ${normalized} atribuído a ${instance.name}`);
    return instance.name;
}

// Cancelar timeout de PIX por telefone
function cancelPixTimeout(phone) {
    const normalized = normalizePhone(phone);
    
    if (pixTimeouts.has(normalized)) {
        const timeoutData = pixTimeouts.get(normalized);
        clearTimeout(timeoutData.timeout);
        pixTimeouts.delete(normalized);
        console.log(`🗑️ Timeout PIX cancelado para ${normalized} (pedido: ${timeoutData.orderCode})`);
        return true;
    }
    
    return false;
}

// Registrar evento no histórico
function logEvent(eventType, phone, instance, status = 'pending') {
    const event = {
        id: Date.now() + Math.random(),
        timestamp: new Date(),
        event_type: eventType,
        phone: phone,
        instance: instance,
        status: status, // 'pending', 'sent', 'error'
        n8n_sent_at: null,
        error: null
    };
    
    eventHistory.unshift(event);
    
    // Manter apenas últimas 24h (aproximadamente 1000 eventos)
    if (eventHistory.length > 1000) {
        eventHistory = eventHistory.slice(0, 1000);
    }
    
    return event.id;
}

// Atualizar status do evento
function updateEventStatus(eventId, status, error = null) {
    const event = eventHistory.find(e => e.id === eventId);
    if (event) {
        event.status = status;
        event.n8n_sent_at = status === 'sent' ? new Date() : null;
        event.error = error;
    }
}

// Enviar para N8N
async function sendToN8N(eventData, eventId = null) {
    try {
        console.log(`📤 Enviando para N8N: ${eventData.evento}`);
        console.log(`📤 Dados completos:`, JSON.stringify(eventData, null, 2));
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        console.log(`✅ N8N respondeu: ${response.status}`);
        
        if (eventId) {
            updateEventStatus(eventId, 'sent');
        }
        
        return { success: true };
    } catch (error) {
        console.error(`❌ Erro N8N: ${error.message}`);
        
        if (eventId) {
            updateEventStatus(eventId, 'error', error.message);
        }
        
        return { success: false, error: error.message };
    }
}

// Job de limpeza periódica
function cleanupOldData() {
    const now = Date.now();
    const cutoff = now - DATA_RETENTION;
    let cleaned = 0;
    
    // Limpar conversas antigas
    for (const [phone, state] of conversationState.entries()) {
        if (state.createdAt && state.createdAt.getTime() < cutoff) {
            conversationState.delete(phone);
            cleaned++;
        }
    }
    
    // Limpar mapeamentos antigos
    for (const [phone, mapping] of clientInstanceMap.entries()) {
        if (mapping.createdAt && mapping.createdAt.getTime() < cutoff) {
            clientInstanceMap.delete(phone);
            cleaned++;
        }
    }
    
    // Limpar timeouts órfãos
    for (const [phone, data] of pixTimeouts.entries()) {
        if (data.createdAt && data.createdAt.getTime() < cutoff) {
            clearTimeout(data.timeout);
            pixTimeouts.delete(phone);
            cleaned++;
        }
    }
    
    // Limpar eventos antigos (manter últimas 24h)
    const oldEventCount = eventHistory.length;
    eventHistory = eventHistory.filter(event => 
        event.timestamp.getTime() > cutoff
    );
    cleaned += oldEventCount - eventHistory.length;
    
    console.log(`🧹 Limpeza executada: ${cleaned} itens removidos`);
}

// Executar limpeza periodicamente
setInterval(cleanupOldData, CLEANUP_INTERVAL);

// ============ WEBHOOK KIRVANO - PERSONALIZADO DANILO ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        
        console.log(`\n📨 WEBHOOK KIRVANO RECEBIDO:`);
        console.log(`Event: ${data.event}`);
        console.log(`Status: ${data.status}`);
        console.log(`Sale ID: ${data.sale_id}`);
        console.log(`Customer: ${data.customer?.name}`);
        console.log(`Phone: ${data.customer?.phone_number}`);
        console.log(`Offer ID: ${data.products?.[0]?.offer_id}`);
        
        const event = data.event;
        const status = data.status;
        const saleId = data.sale_id;
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        const offerId = data.products?.[0]?.offer_id;
        
        // Normalizar telefone
        const normalizedPhone = normalizePhone(customerPhone);
        
        if (!normalizedPhone) {
            console.log('⚠️ Telefone inválido ou ausente');
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        // Verificar idempotência
        const idempotencyKey = `${event}:${normalizedPhone}:${saleId}`;
        if (checkIdempotency(idempotencyKey)) {
            return res.json({ success: true, message: 'Evento duplicado ignorado' });
        }
        
        // Identificar produto pelo offer_id
        let productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
        console.log(`📦 Produto identificado: ${productType} (offer_id: ${offerId})`);
        
        // Obter próxima instância (round-robin sticky)
        const instance = getNextInstanceForClient(normalizedPhone);
        
        // ========== VENDA APROVADA ==========
        if (isApprovedEvent(event, status)) {
            console.log(`✅ VENDA APROVADA - ${saleId} - ${customerName}`);
            
            // SEMPRE cancelar timeout por telefone
            const timeoutCanceled = cancelPixTimeout(normalizedPhone);
            if (timeoutCanceled) {
                console.log(`✨ Timeout cancelado com sucesso para ${normalizedPhone}`);
            }
            
            // Criar/atualizar estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: saleId,
                product: productType,
                instance: instance,
                original_event: 'aprovada',
                response_count: 0,
                waiting_for_response: false, // COMEÇA FALSE
                client_name: customerName,
                amount: totalPrice,
                createdAt: new Date()
            });
            
            // Registrar evento no histórico
            const eventId = logEvent('aprovada', normalizedPhone, instance);
            
            // Enviar para N8N - FORMATO PADRONIZADO
            const eventData = {
                evento: 'venda_aprovada',
                produto: productType,
                instancia: instance,
                evento_origem: 'aprovada',
                cliente: {
                    nome: customerName.split(' ')[0], // Só primeiro nome
                    telefone: normalizedPhone,
                    nome_completo: customerName
                },
                pedido: {
                    codigo: saleId,
                    valor: totalPrice,
                    offer_id: offerId
                },
                timestamp: new Date().toISOString(),
                dados_originais: data
            };
            
            await sendToN8N(eventData, eventId);
            res.json({ success: true, message: 'Venda aprovada processada' });
        }
        
        // ========== PIX PENDENTE ==========
        else if (isPendingPixEvent(event, status)) {
            console.log(`⏳ PIX PENDENTE - ${saleId} - ${customerName}`);
            
            // Cancelar timeout anterior se existir
            cancelPixTimeout(normalizedPhone);
            
            // Criar estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: saleId,
                product: productType,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                waiting_for_response: false, // COMEÇA FALSE - vai virar TRUE após timeout
                client_name: customerName,
                amount: totalPrice,
                pix_url: data.payment?.qrcode_image || data.payment?.qrcode || '',
                createdAt: new Date()
            });
            
            // Criar timeout de 7 minutos
            const timeout = setTimeout(async () => {
                console.log(`⏰ TIMEOUT PIX: ${saleId} para ${normalizedPhone}`);
                
                // Verificar se ainda está pendente
                const state = conversationState.get(normalizedPhone);
                if (state && state.order_code === saleId) {
                    // Registrar evento no histórico
                    const eventId = logEvent('pix', normalizedPhone, instance);
                    
                    // Enviar evento pix_timeout para N8N - FORMATO PADRONIZADO
                    const eventData = {
                        evento: 'pix_timeout',
                        produto: productType,
                        instancia: instance,
                        evento_origem: 'pix',
                        cliente: {
                            nome: customerName.split(' ')[0], // Só primeiro nome
                            telefone: normalizedPhone,
                            nome_completo: customerName
                        },
                        pedido: {
                            codigo: saleId,
                            valor: totalPrice,
                            pix_url: state.pix_url || '',
                            offer_id: offerId
                        },
                        timeout: true, // Flag para identificar que é timeout
                        timestamp: new Date().toISOString(),
                        dados_originais: data
                    };
                    
                    await sendToN8N(eventData, eventId);
                    
                    // ========== CORREÇÃO CRÍTICA - ADICIONAR ESSAS LINHAS ==========
                    // Marca como esperando resposta após enviar pix_timeout
                    state.waiting_for_response = true;
                    state.last_system_message = new Date();
                    conversationState.set(normalizedPhone, state);
                    console.log(`✅ Estado atualizado - Esperando resposta de ${normalizedPhone}`);
                    // ========== FIM DA CORREÇÃO ==========
                }
                
                pixTimeouts.delete(normalizedPhone);
            }, PIX_TIMEOUT);
            
            // Armazenar timeout por telefone
            pixTimeouts.set(normalizedPhone, {
                timeout: timeout,
                orderCode: saleId,
                product: productType,
                createdAt: new Date()
            });
            
            console.log(`⏱️ Timeout agendado para ${normalizedPhone} - 7 minutos`);
            res.json({ success: true, message: 'PIX pendente registrado' });
        }
        
        else {
            console.log(`⚠️ Evento ignorado: ${event} - ${status}`);
            res.json({ success: true, message: 'Evento ignorado' });
        }
        
    } catch (error) {
        console.error('❌ ERRO KIRVANO:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ WEBHOOK EVOLUTION - SISTEMA DE RESPOSTA OBRIGATÓRIA ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        const normalized = normalizePhone(clientNumber);
        
        console.log(`\n📱 Evolution: ${normalized} | FromMe: ${fromMe} | Texto: "${messageText.substring(0, 50)}..."`);
        console.log(`🔍 Conversas ativas: ${conversationState.size}`);
        console.log(`🔍 Buscando conversa para: ${normalized}`);
        console.log(`🔍 Conversas existentes:`, Array.from(conversationState.keys()));
        
        // Buscar estado da conversa
        const clientState = conversationState.get(normalized);
        
        if (!clientState) {
            console.log(`❓ Cliente ${normalized} não está em conversa ativa`);
            return res.json({ success: true, message: 'Cliente não encontrado' });
        }
        
        // MENSAGEM ENVIADA PELO SISTEMA
        console.log(`🔍 fromMe: ${fromMe}`);
        console.log(`🔍 clientState existe: ${!!clientState}`);
        if (clientState) {
        console.log(`🔍 waiting_for_response atual: ${clientState.waiting_for_response}`);
        console.log(`🔍 response_count atual: ${clientState.response_count}`);
}
        if (fromMe) {
            console.log(`📤 Sistema enviou MSG para ${normalized} - Habilitando resposta`);
            clientState.waiting_for_response = true;
            clientState.last_system_message = new Date();
            conversationState.set(normalized, clientState);
        }
        
        // RESPOSTA DO CLIENTE (SISTEMA DE RESPOSTA OBRIGATÓRIA)
        else {
            // Verificar se é a primeira resposta válida
            if (clientState.waiting_for_response && clientState.response_count === 0) {
                // Verificar idempotência da resposta_01
                const replyKey = `RESPOSTA_01:${normalized}:${clientState.order_code}`;
                if (checkIdempotency(replyKey)) {
                    console.log('🔁 resposta_01 duplicada — ignorada');
                    return res.json({ success: true, message: 'Resposta duplicada ignorada' });
                }
                
                console.log(`📥 PRIMEIRA RESPOSTA de ${normalized} - CONTINUANDO FLUXO`);
                
                // Marcar como respondido
                clientState.response_count = 1;
                clientState.waiting_for_response = false;
                conversationState.set(normalized, clientState);
                
                // Registrar evento no histórico
                const eventId = logEvent('resposta', normalized, clientState.instance);
                
                // Enviar resposta_01 para N8N - FORMATO PADRONIZADO
                const eventData = {
                    evento: 'resposta_01',
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event, // 'pix' ou 'aprovada'
                    cliente: {
                        telefone: normalized,
                        nome: clientState.client_name.split(' ')[0] // Só primeiro nome
                    },
                    resposta: {
                        numero: 1,
                        conteudo: messageText,
                        timestamp: new Date().toISOString()
                    },
                    pedido: {
                        codigo: clientState.order_code,
                        billet_url: clientState.pix_url || ''
                    },
                    timestamp: new Date().toISOString()
                };
                
                await sendToN8N(eventData, eventId);
                console.log(`✅ Resposta_01 enviada para N8N - FLUXO CONTINUARÁ`);
            }
            else if (!clientState.waiting_for_response) {
                console.log(`⚠️ Cliente respondeu antes da MSG_01 - FLUXO NÃO CONTINUA`);
            }
            else {
                console.log(`⚠️ Resposta adicional do cliente - ignorada`);
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ ERRO Evolution:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ENDPOINTS DE STATUS E MONITORAMENTO ============
app.get('/status', (req, res) => {
    // Filtrar eventos das últimas 24h
    const last24h = Date.now() - DATA_RETENTION;
    const recentEvents = eventHistory.filter(event => 
        event.timestamp.getTime() > last24h
    );

    // Métricas
    const pendingPix = Array.from(pixTimeouts.keys()).length;
    const activeConversations = conversationState.size;
    const cacheSize = idempotencyCache.size;
    
    // Lista de PIX pendentes
    const pendingList = Array.from(pixTimeouts.entries()).map(([phone, data]) => ({
        phone: phone,
        order_code: data.orderCode,
        product: data.product,
        created_at: data.createdAt
    }));
    
    // Lista de conversas ativas
    const conversationsList = Array.from(conversationState.entries()).map(([phone, state]) => ({
        phone: phone,
        order_code: state.order_code,
        product: state.product,
        instance: state.instance,
        original_event: state.original_event,
        response_count: state.response_count,
        waiting_for_response: state.waiting_for_response
    }));
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        config: {
            n8n_webhook: N8N_WEBHOOK_URL,
            evolution_base_url: EVOLUTION_BASE_URL,
            instances_count: INSTANCES.length,
            products_mapped: Object.keys(PRODUCT_MAPPING).length,
            pix_timeout_minutes: PIX_TIMEOUT / (1000 * 60)
        },
        events: recentEvents,
        stats: {
            total_events: recentEvents.length,
            sent_events: recentEvents.filter(e => e.status === 'sent').length,
            error_events: recentEvents.filter(e => e.status === 'error').length
        },
        metrics: {
            pending_pix: pendingPix,
            active_conversations: activeConversations,
            idempotency_cache: cacheSize
        },
        pending_list: pendingList,
        conversations_list: conversationsList,
        instances: INSTANCES.map(i => ({ name: i.name, phone: i.phone })),
        products: PRODUCT_MAPPING
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        system: 'Danilo Kirvano System v1.0'
    });
});

// ============ PAINEL DE CONTROLE PERSONALIZADO ============
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <title>🧠 Cérebro Danilo - Sistema Kirvano</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
        }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        h1 { 
            color: #333; 
            font-size: 2.5rem; 
            margin-bottom: 10px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .subtitle {
            color: #666;
            font-size: 1rem;
            margin-bottom: 20px;
        }
        
        .config-info {
            background: #f7fafc;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .config-item {
            display: flex;
            justify-content: space-between;
            padding: 5px 0;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .config-item:last-child {
            border-bottom: none;
        }
        
        .config-label {
            color: #718096;
            font-weight: 600;
        }
        
        .config-value {
            color: #2d3748;
            font-family: monospace;
            font-size: 0.9rem;
        }
        
        .status-active {
            color: #38a169;
            font-weight: bold;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card { 
            background: white;
            border-radius: 15px;
            padding: 20px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        }
        
        .stat-card.warning { border-left: 4px solid #ed8936; }
        .stat-card.info { border-left: 4px solid #4299e1; }
        .stat-card.success { border-left: 4px solid #48bb78; }
        .stat-card.danger { border-left: 4px solid #f56565; }
        
        .stat-label {
            font-size: 0.9rem;
            color: #718096;
            margin-bottom: 10px;
            text-transform: uppercase;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: #2d3748;
        }
        
        .content-panel {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #f7fafc;
        }
        
        .tab {
            padding: 12px 24px;
            background: none;
            border: none;
            color: #718096;
            font-weight: 600;
            cursor: pointer;
            position: relative;
        }
        
        .tab.active {
            color: #667eea;
        }
        
        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: #667eea;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        
        th {
            background: #f7fafc;
            padding: 12px;
            text-align: left;
            font-weight: 600;
            color: #2d3748;
            font-size: 0.9rem;
        }
        
        td {
            padding: 12px;
            border-bottom: 1px solid #f7fafc;
            font-size: 0.95rem;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
        }
        
        .badge-success { background: #c6f6d5; color: #22543d; }
        .badge-warning { background: #fbd38d; color: #975a16; }
        .badge-info { background: #bee3f8; color: #2c5282; }
        .badge-danger { background: #fed7d7; color: #742a2a; }
        
        .btn {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 25px;
            cursor: pointer;
            font-weight: 600;
            margin-right: 10px;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #718096;
        }
        
        .product-list {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        
        .product-card {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 15px;
            border-left: 4px solid #667eea;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🧠 Cérebro Danilo - Sistema Kirvano</h1>
            <div class="subtitle">Monitoramento Completo | Evolution API + N8N</div>
            
            <div class="config-info">
                <div class="config-item">
                    <span class="config-label">N8N Webhook:</span>
                    <span class="config-value">${N8N_WEBHOOK_URL}</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Instâncias Ativas:</span>
                    <span class="config-value status-active">${INSTANCES.length} instâncias (D01-D10)</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Produtos Mapeados:</span>
                    <span class="config-value status-active">${Object.keys(PRODUCT_MAPPING).length} produtos (FAB/CS/NAT)</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Timeout PIX:</span>
                    <span class="config-value">${PIX_TIMEOUT / (1000 * 60)} minutos</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Sistema de Resposta:</span>
                    <span class="config-value status-active">OBRIGATÓRIA (Anti-queda)</span>
                </div>
            </div>
            
            <div class="stats-grid" id="stats">
                <div class="stat-card warning">
                    <div class="stat-label">⏳ PIX Pendentes</div>
                    <div class="stat-value" id="pendingPix">0</div>
                </div>
                
                <div class="stat-card info">
                    <div class="stat-label">💬 Conversas Ativas</div>
                    <div class="stat-value" id="activeConv">0</div>
                </div>
                
                <div class="stat-card success">
                    <div class="stat-label">🚀 Eventos Enviados</div>
                    <div class="stat-value" id="sentEvents">0</div>
                </div>
                
                <div class="stat-card danger">
                    <div class="stat-label">❌ Eventos com Erro</div>
                    <div class="stat-value" id="errorEvents">0</div>
                </div>
            </div>
            
            <button class="btn" onclick="refreshData()">🔄 Atualizar</button>
            <button class="btn" onclick="testWebhook()">🧪 Testar Webhook</button>
        </div>
        
        <div class="content-panel">
            <div class="tabs">
                <button class="tab active" onclick="switchTab('overview')">📊 Visão Geral</button>
                <button class="tab" onclick="switchTab('pending')">⏳ PIX Pendentes</button>
                <button class="tab" onclick="switchTab('conversations')">💬 Conversas</button>
                <button class="tab" onclick="switchTab('instances')">🤖 Instâncias</button>
                <button class="tab" onclick="switchTab('products')">📦 Produtos</button>
            </div>
            
            <div id="tabContent">
                <div class="empty-state">
                    <p>Carregando dados...</p>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentTab = 'overview';
        let statusData = null;
        
        async function refreshData() {
            try {
                const response = await fetch('/status');
                statusData = await response.json();
                
                document.getElementById('pendingPix').textContent = statusData.metrics.pending_pix;
                document.getElementById('activeConv').textContent = statusData.metrics.active_conversations;
                document.getElementById('sentEvents').textContent = statusData.stats.sent_events;
                document.getElementById('errorEvents').textContent = statusData.stats.error_events;
                
                updateTabContent();
            } catch (error) {
                console.error('Erro ao carregar dados:', error);
            }
        }
        
        async function testWebhook() {
            alert('Função de teste será implementada. Verifique os logs do sistema.');
        }
        
        function switchTab(tab) {
            currentTab = tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            updateTabContent();
        }
        
        function updateTabContent() {
            const content = document.getElementById('tabContent');
            
            if (!statusData) {
                content.innerHTML = '<div class="empty-state"><p>Carregando...</p></div>';
                return;
            }
            
            if (currentTab === 'overview') {
                content.innerHTML = '<div><h3>📊 Sistema Online e Funcionando</h3>' +
                    '<p>Webhook Kirvano configurado e recebendo dados corretamente.</p>' +
                    '<p>Sistema de timeout de 7 minutos ativo para PIX pendentes.</p>' +
                    '<p>Sistema de resposta obrigatória ativo (anti-queda).</p></div>';
                    
            } else if (currentTab === 'pending') {
                if (statusData.pending_list.length === 0) {
                    content.innerHTML = '<div class="empty-state"><p>Nenhum PIX pendente</p></div>';
                } else {
                    let html = '<table><thead><tr><th>Telefone</th><th>Pedido</th><th>Produto</th><th>Criado</th></tr></thead><tbody>';
                    statusData.pending_list.forEach(item => {
                        const createdAt = new Date(item.created_at).toLocaleString('pt-BR');
                        html += '<tr><td>' + item.phone + '</td><td>' + item.order_code + '</td>';
                        html += '<td><span class="badge badge-warning">' + item.product + '</span></td>';
                        html += '<td>' + createdAt + '</td></tr>';
                    });
                    html += '</tbody></table>';
                    content.innerHTML = html;
                }
                
            } else if (currentTab === 'conversations') {
                if (statusData.conversations_list.length === 0) {
                    content.innerHTML = '<div class="empty-state"><p>Nenhuma conversa ativa</p></div>';
                } else {
                    let html = '<table><thead><tr><th>Telefone</th><th>Pedido</th><th>Produto</th><th>Instância</th><th>Origem</th><th>Status</th></tr></thead><tbody>';
                    statusData.conversations_list.forEach(conv => {
                        html += '<tr><td>' + conv.phone + '</td><td>' + conv.order_code + '</td>';
                        html += '<td><span class="badge badge-info">' + conv.product + '</span></td>';
                        html += '<td>' + conv.instance + '</td>';
                        html += '<td><span class="badge badge-warning">' + conv.original_event + '</span></td>';
                        html += '<td><span class="badge badge-' + (conv.waiting_for_response ? 'warning' : 'success') + '">';
                        html += (conv.waiting_for_response ? 'Aguardando' : 'Respondido') + '</span></td></tr>';
                    });
                    html += '</tbody></table>';
                    content.innerHTML = html;
                }
                
            } else if (currentTab === 'instances') {
                let html = '<table><thead><tr><th>Nome</th><th>Telefone</th><th>ID</th></tr></thead><tbody>';
                statusData.instances.forEach(inst => {
                    html += '<tr><td><strong>' + inst.name + '</strong></td>';
                    html += '<td>' + inst.phone + '</td>';
                    html += '<td><code style="font-size:0.8rem">' + statusData.instances.find(i => i.name === inst.name)?.id || 'N/A' + '</code></td></tr>';
                });
                html += '</tbody></table>';
                content.innerHTML = html;
                
            } else if (currentTab === 'products') {
                let html = '<div class="product-list">';
                
                // Agrupar produtos
                const products = {
                    'FAB': Object.entries(statusData.products).filter(([k,v]) => v === 'FAB'),
                    'CS': Object.entries(statusData.products).filter(([k,v]) => v === 'CS'),
                    'NAT': Object.entries(statusData.products).filter(([k,v]) => v === 'NAT')
                };
                
                Object.entries(products).forEach(([type, items]) => {
                    html += '<div class="product-card">';
                    html += '<h4>Produto: ' + type + '</h4>';
                    html += '<p><strong>' + items.length + ' offer_id(s) mapeado(s)</strong></p>';
                    items.forEach(([offerId, product]) => {
                        html += '<p><code>' + offerId + '</code></p>';
                    });
                    html += '</div>';
                });
                
                html += '</div>';
                content.innerHTML = html;
            }
        }
        
        // Auto-refresh a cada 10 segundos
        refreshData();
        setInterval(refreshData, 10000);
    </script>
</body>
</html>`;
    
    res.send(html);
});

// ============ INICIALIZAÇÃO ============
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║   🧠 CÉREBRO DANILO - SISTEMA KIRVANO v1.0   ║
╚══════════════════════════════════════════════╝

🎯 CONFIGURAÇÕES PERSONALIZADAS:
   • N8N: ${N8N_WEBHOOK_URL}
   • Evolution: ${EVOLUTION_BASE_URL}
   • Instâncias: ${INSTANCES.length} (D01-D10)
   • Produtos: ${Object.keys(PRODUCT_MAPPING).length} (FAB/CS/NAT)
   • Timeout PIX: ${PIX_TIMEOUT / (1000 * 60)} minutos

📡 WEBHOOKS:
   • Kirvano: /webhook/kirvano
   • Evolution: /webhook/evolution

📊 ENDPOINTS:
   • Painel: http://localhost:${PORT}
   • Status: http://localhost:${PORT}/status
   • Health: http://localhost:${PORT}/health

🚀 FUNCIONALIDADES ATIVAS:
   ✅ PIX Timeout (7 minutos)
   ✅ Instâncias Sticky (Round-robin)
   ✅ Resposta Obrigatória (Anti-queda)
   ✅ Identificação por offer_id
   ✅ Normalização de telefone
   ✅ Sistema de idempotência
   ✅ Limpeza automática (24h)

🔥 SISTEMA PERSONALIZADO DANILO PRONTO!
════════════════════════════════════════════════`);
});
