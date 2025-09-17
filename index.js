const express = require('express');
const axios = require('axios');
const app = express();

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/kirvano-pag';
const EVOLUTION_API_URL = 'https://evo.flowzap.fun';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const DATA_RETENTION_TIME = 24 * 60 * 60 * 1000; // 24 horas
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos

// Armazenamento em memória com timestamps
let pendingPixOrders = new Map();
let systemLogs = [];
let clientInstanceMap = new Map(); // { phone: { instance: string, createdAt: Date } }
let conversationState = new Map(); // { phone: { ...state, createdAt: Date } }
let deliveryReports = [];
let eventHistory = []; // com retenção de 24h
let instanceCounter = 0;
let systemStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    startTime: new Date()
};

// Mapeamento dos produtos KIRVANO (ATUALIZADO)
const PRODUCT_MAPPING = {
    '69f801e6-a26e-42bb-aa38-89e2767b489f': 'FAB',
    'e79419d3-5b71-4f90-954b-b05e94de8d98': 'CS',
    '06539c76-40ee-4811-8351-ab3f5ccc4437': 'CS1',
    '08be89d4-96a7-40fd-9d32-ecc4b5cffcdb': 'NAT19',
    '4230eda0-4762-47e6-b8e7-72ab8a2f6f90': 'NAT49', 
    'f2289442-c3bc-415f-b6bd-5bc3c3e8e2f7': 'NAT100'
};

// Instâncias disponíveis (sem verificação de conexão)
const INSTANCES = [
    { name: 'D01', id: 'E72041FBC017-4C78-B82B-A0D90F95FE5F' },
    { name: 'D02', id: '36B65257D668-413C-BB29-7150092099C7' },
    { name: 'D03', id: '6B605CD2B735-4A89-A914-7E9508B7481B' },
    { name: 'D04', id: 'F13E2FF90F39-4DC7-8D0D-FDB1395B4546' },
    { name: 'D05', id: '3775095A36FB-43C4-AA9C-5335D120F466' },
    { name: 'D06', id: 'F27A6A27213E-40C3-A334-F3A2261E3631' },
    { name: 'D07', id: '0082AB570022-4AE3-95ED-031DA35DAA30' },
    { name: 'D08', id: 'DEB1AB14A0FF-4D98-8F60-D5341D239EEC' },
    { name: 'D09', id: '5FCEB25F0FD8-432A-8BCE-CF689E180B3E' },
    { name: 'D10', id: '2EFC39376BAD-43F8-A6E8-61349EEFAAD3' },
];

app.use(express.json());

// Função para obter data/hora em Brasília
function getBrazilTime() {
    return new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

function getBrazilDate() {
    return new Date().toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

function getBrazilTimeOnly() {
    return new Date().toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

// ========== FUNÇÃO DE LOCALIZAÇÃO COMPLETA (BASEADA NO CODE v2.7) ==========
function getLocationByDDD(telefone) {
    if (!telefone) return { cidade: 'Brasil', estado: '', regiao: 'Brasil', localizacao_completa: 'Brasil' };
    
    var numeroLimpo = telefone.replace(/\D/g, '');
    var ddd = '';
    
    // Extrair DDD do telefone normalizado
    if (numeroLimpo.length > 4 && numeroLimpo.indexOf("55") === 0) {
        ddd = numeroLimpo.substring(2, 4);
    } else if (numeroLimpo.length >= 2) {
        ddd = numeroLimpo.substring(0, 2);
    }
    
    // Mapeamento COMPLETO de todos os DDDs brasileiros (EXATO DO CODE v2.7)
    var ddds = {
        '11': { cidade: 'São Paulo', estado: 'SP', regiao: 'Grande São Paulo' },
        '12': { cidade: 'São José dos Campos', estado: 'SP', regiao: 'Vale do Paraíba' },
        '13': { cidade: 'Santos', estado: 'SP', regiao: 'Baixada Santista' },
        '14': { cidade: 'Bauru', estado: 'SP', regiao: 'Interior de SP' },
        '15': { cidade: 'Sorocaba', estado: 'SP', regiao: 'Interior de SP' },
        '16': { cidade: 'Ribeirão Preto', estado: 'SP', regiao: 'Interior de SP' },
        '17': { cidade: 'São José do Rio Preto', estado: 'SP', regiao: 'Interior de SP' },
        '18': { cidade: 'Presidente Prudente', estado: 'SP', regiao: 'Interior de SP' },
        '19': { cidade: 'Campinas', estado: 'SP', regiao: 'Região de Campinas' },
        '21': { cidade: 'Rio de Janeiro', estado: 'RJ', regiao: 'Rio de Janeiro' },
        '22': { cidade: 'Campos dos Goytacazes', estado: 'RJ', regiao: 'Norte Fluminense' },
        '24': { cidade: 'Volta Redonda', estado: 'RJ', regiao: 'Sul Fluminense' },
        '27': { cidade: 'Vitória', estado: 'ES', regiao: 'Grande Vitória' },
        '28': { cidade: 'Cachoeiro de Itapemirim', estado: 'ES', regiao: 'Sul do ES' },
        '31': { cidade: 'Belo Horizonte', estado: 'MG', regiao: 'Grande BH' },
        '32': { cidade: 'Juiz de Fora', estado: 'MG', regiao: 'Zona da Mata' },
        '33': { cidade: 'Governador Valadares', estado: 'MG', regiao: 'Vale do Rio Doce' },
        '34': { cidade: 'Uberlândia', estado: 'MG', regiao: 'Triângulo Mineiro' },
        '35': { cidade: 'Poços de Caldas', estado: 'MG', regiao: 'Sul de MG' },
        '37': { cidade: 'Divinópolis', estado: 'MG', regiao: 'Centro-Oeste de MG' },
        '38': { cidade: 'Montes Claros', estado: 'MG', regiao: 'Norte de MG' },
        '41': { cidade: 'Curitiba', estado: 'PR', regiao: 'Grande Curitiba' },
        '42': { cidade: 'Ponta Grossa', estado: 'PR', regiao: 'Campos Gerais' },
        '43': { cidade: 'Londrina', estado: 'PR', regiao: 'Norte do Paraná' },
        '44': { cidade: 'Maringá', estado: 'PR', regiao: 'Noroeste do Paraná' },
        '45': { cidade: 'Foz do Iguaçu', estado: 'PR', regiao: 'Oeste do Paraná' },
        '46': { cidade: 'Francisco Beltrão', estado: 'PR', regiao: 'Sudoeste do Paraná' },
        '47': { cidade: 'Joinville', estado: 'SC', regiao: 'Norte de SC' },
        '48': { cidade: 'Florianópolis', estado: 'SC', regiao: 'Grande Florianópolis' },
        '49': { cidade: 'Chapecó', estado: 'SC', regiao: 'Oeste de SC' },
        '51': { cidade: 'Porto Alegre', estado: 'RS', regiao: 'Grande Porto Alegre' },
        '53': { cidade: 'Pelotas', estado: 'RS', regiao: 'Sul do RS' },
        '54': { cidade: 'Caxias do Sul', estado: 'RS', regiao: 'Serra Gaúcha' },
        '55': { cidade: 'Santa Maria', estado: 'RS', regiao: 'Centro do RS' },
        '61': { cidade: 'Brasília', estado: 'DF', regiao: 'Distrito Federal' },
        '62': { cidade: 'Goiânia', estado: 'GO', regiao: 'Grande Goiânia' },
        '63': { cidade: 'Palmas', estado: 'TO', regiao: 'Tocantins' },
        '64': { cidade: 'Rio Verde', estado: 'GO', regiao: 'Sudoeste Goiano' },
        '65': { cidade: 'Cuiabá', estado: 'MT', regiao: 'Grande Cuiabá' },
        '66': { cidade: 'Rondonópolis', estado: 'MT', regiao: 'Sul de MT' },
        '67': { cidade: 'Campo Grande', estado: 'MS', regiao: 'Mato Grosso do Sul' },
        '68': { cidade: 'Rio Branco', estado: 'AC', regiao: 'Acre' },
        '69': { cidade: 'Porto Velho', estado: 'RO', regiao: 'Rondônia' },
        '71': { cidade: 'Salvador', estado: 'BA', regiao: 'Grande Salvador' },
        '73': { cidade: 'Ilhéus', estado: 'BA', regiao: 'Sul da Bahia' },
        '74': { cidade: 'Juazeiro', estado: 'BA', regiao: 'Norte da Bahia' },
        '75': { cidade: 'Feira de Santana', estado: 'BA', regiao: 'Recôncavo Baiano' },
        '77': { cidade: 'Barreiras', estado: 'BA', regiao: 'Oeste da Bahia' },
        '79': { cidade: 'Aracaju', estado: 'SE', regiao: 'Sergipe' },
        '81': { cidade: 'Recife', estado: 'PE', regiao: 'Grande Recife' },
        '82': { cidade: 'Maceió', estado: 'AL', regiao: 'Alagoas' },
        '83': { cidade: 'João Pessoa', estado: 'PB', regiao: 'Paraíba' },
        '84': { cidade: 'Natal', estado: 'RN', regiao: 'Rio Grande do Norte' },
        '85': { cidade: 'Fortaleza', estado: 'CE', regiao: 'Grande Fortaleza' },
        '86': { cidade: 'Teresina', estado: 'PI', regiao: 'Piauí' },
        '87': { cidade: 'Petrolina', estado: 'PE', regiao: 'Sertão de PE' },
        '88': { cidade: 'Sobral', estado: 'CE', regiao: 'Norte do Ceará' },
        '89': { cidade: 'Picos', estado: 'PI', regiao: 'Sul do Piauí' },
        '91': { cidade: 'Belém', estado: 'PA', regiao: 'Grande Belém' },
        '92': { cidade: 'Manaus', estado: 'AM', regiao: 'Amazonas' },
        '93': { cidade: 'Santarém', estado: 'PA', regiao: 'Oeste do Pará' },
        '94': { cidade: 'Marabá', estado: 'PA', regiao: 'Sul do Pará' },
        '95': { cidade: 'Boa Vista', estado: 'RR', regiao: 'Roraima' },
        '96': { cidade: 'Macapá', estado: 'AP', regiao: 'Amapá' },
        '97': { cidade: 'Coari', estado: 'AM', regiao: 'Médio Solimões' },
        '98': { cidade: 'São Luís', estado: 'MA', regiao: 'Grande São Luís' },
        '99': { cidade: 'Imperatriz', estado: 'MA', regiao: 'Sul do Maranhão' }
    };
    
    var localizacao = ddds[ddd] || { cidade: 'Brasil', estado: '', regiao: 'Brasil' };
    
    // Adicionar campo localizacao_completa (EXATO DO CODE v2.7)
    localizacao.localizacao_completa = localizacao.estado ? 
        localizacao.cidade + '/' + localizacao.estado : 
        localizacao.cidade;
    
    return localizacao;
}

// Função para adicionar evento ao histórico (com retenção de 24h)
function addEventToHistory(eventType, status, data) {
    const event = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString(),
        date: getBrazilDate(),
        time: getBrazilTimeOnly(),
        type: eventType,
        status: status,
        clientName: data.clientName || 'N/A',
        clientPhone: data.clientPhone || 'N/A',
        orderCode: data.orderCode || 'N/A',
        product: data.product || 'N/A',
        instance: data.instance || 'N/A',
        amount: data.amount || 0,
        responseContent: data.responseContent || null,
        errorMessage: data.errorMessage || null,
        details: data
    };
    
    eventHistory.unshift(event);
    
    // Atualiza estatísticas
    systemStats.totalEvents++;
    if (status === 'success') {
        systemStats.successfulEvents++;
    } else if (status === 'failed') {
        systemStats.failedEvents++;
    }
    
    return event;
}

// Função para adicionar logs
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        brazilTime: getBrazilTime(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.brazilTime}] ${type.toUpperCase()}: ${message}`);
}

// Função para adicionar relatório de entrega
function addDeliveryReport(type, status, data) {
    const report = {
        timestamp: new Date().toISOString(),
        brazilTime: getBrazilTime(),
        type: type,
        status: status,
        data: data
    };
    
    deliveryReports.push(report);
}

// Função para obter instância (sticky por lead)
function getInstanceForClient(clientNumber) {
    // Se cliente já tem instância atribuída, retorna a mesma
    if (clientInstanceMap.has(clientNumber)) {
        const mapping = clientInstanceMap.get(clientNumber);
        addLog('info', `✅ Cliente ${clientNumber} mantido na instância ${mapping.instance}`);
        return mapping.instance;
    }
    
    // Atribui nova instância via round-robin
    const instance = INSTANCES[instanceCounter % INSTANCES.length];
    instanceCounter++;
    
    // Salva mapeamento com timestamp
    clientInstanceMap.set(clientNumber, {
        instance: instance.name,
        createdAt: new Date()
    });
    
    addLog('info', `✅ Cliente ${clientNumber} atribuído à instância ${instance.name}`);
    return instance.name;
}

// Funções auxiliares
function getFirstName(fullName) {
    return fullName ? fullName.split(' ')[0] : 'Cliente';
}

function formatPhoneNumber(extension, areaCode, number) {
    return `${extension}${areaCode}${number}`;
}

function getProductByPlanCode(planCode) {
    return PRODUCT_MAPPING[planCode] || 'UNKNOWN';
}

// Nova função para mapear IDs da Kirvano
function getProductByKirvanoId(kirvanoId) {
    return PRODUCT_MAPPING[kirvanoId] || 'UNKNOWN';
}

// Job de limpeza de dados com mais de 24h
function cleanupOldData() {
    const now = Date.now();
    const cutoffTime = now - DATA_RETENTION_TIME;
    
    // Limpa eventHistory
    const beforeEventCount = eventHistory.length;
    eventHistory = eventHistory.filter(e => new Date(e.timestamp).getTime() > cutoffTime);
    
    // Limpa conversationState
    const beforeConvCount = conversationState.size;
    for (const [phone, state] of conversationState.entries()) {
        if (state.createdAt && state.createdAt.getTime() < cutoffTime) {
            conversationState.delete(phone);
        }
    }
    
    // Limpa clientInstanceMap
    const beforeMapCount = clientInstanceMap.size;
    for (const [phone, mapping] of clientInstanceMap.entries()) {
        if (mapping.createdAt && mapping.createdAt.getTime() < cutoffTime) {
            clientInstanceMap.delete(phone);
        }
    }
    
    // Limpa logs e reports
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > cutoffTime);
    deliveryReports = deliveryReports.filter(report => new Date(report.timestamp).getTime() > cutoffTime);
    
    addLog('cleanup', `Limpeza executada: ${beforeEventCount - eventHistory.length} eventos, ${beforeConvCount - conversationState.size} conversas, ${beforeMapCount - clientInstanceMap.size} mapeamentos removidos`);
}

// Executa limpeza periodicamente
setInterval(cleanupOldData, CLEANUP_INTERVAL);

// Webhook Perfect Pay (mantido para compatibilidade)
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const planCode = data.plan?.code;
        const product = getProductByPlanCode(planCode);
        
        const fullName = data.customer?.full_name || 'Cliente';
        const firstName = getFirstName(fullName);
        const phoneNumber = formatPhoneNumber(
            data.customer?.phone_extension || '55',
            data.customer?.phone_area_code || '',
            data.customer?.phone_number || ''
        );
        const amount = data.sale_amount || 0;
        const pixUrl = data.billet_url || '';
        
        // ========== CALCULAR LOCALIZAÇÃO ==========
        const localizacao = getLocationByDDD(phoneNumber);
        const dddCalculado = phoneNumber.length > 4 && phoneNumber.startsWith('55') 
            ? phoneNumber.substring(2, 4) 
            : phoneNumber.substring(0, 2);
        
        addLog('webhook_received', `Perfect: ${orderCode} | Status: ${status} | Produto: ${product} | Cliente: ${firstName} | Fone: ${phoneNumber} | Local: ${localizacao.localizacao_completa}`);
        
        if (status === 'approved') {
            // VENDA APROVADA
            addLog('info', `✅ VENDA APROVADA - ${orderCode} | Produto: ${product} | Local: ${localizacao.localizacao_completa}`);
            
            // Cancela timeout se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ PIX pendente removido: ${orderCode}`);
            }
            
            // Obtém instância sticky para o cliente
            const instance = getInstanceForClient(phoneNumber);
            
            // Cria/atualiza estado da conversa para aprovada
            if (!conversationState.has(phoneNumber)) {
                conversationState.set(phoneNumber, {
                    order_code: orderCode,
                    product: product,
                    instance: instance,
                    original_event: 'aprovada',
                    response_count: 0,
                    last_system_message: null,
                    waiting_for_response: true,
                    client_name: fullName,
                    amount: amount,
                    pix_url: '',
                    billet_url: '',
                    createdAt: new Date()
                });
            } else {
                const state = conversationState.get(phoneNumber);
                state.original_event = 'aprovada';
                state.instance = instance;
                state.waiting_for_response = true;
                state.amount = amount;
            }
            
            // Prepara dados para N8N COM LOCALIZAÇÃO
            const eventData = {
                event_type: 'venda_aprovada',
                produto: product,
                instancia: instance,
                evento_origem: 'aprovada',
                cliente: {
                    nome: firstName,
                    telefone: phoneNumber,
                    nome_completo: fullName
                },
                pedido: {
                    codigo: orderCode,
                    valor: amount,
                    plano: planCode
                },
                cidade: localizacao.cidade,
                estado: localizacao.estado,
                regiao: localizacao.regiao,
                ddd: dddCalculado,
                localizacao_completa: localizacao.localizacao_completa,
                timestamp: new Date().toISOString(),
                brazil_time: getBrazilTime(),
                dados_originais: data
            };
            
            // ENVIA PARA N8N
            const sendResult = await sendToN8N(eventData, 'venda_aprovada');
            
            // Adiciona ao histórico
            addEventToHistory('venda_aprovada', sendResult.success ? 'success' : 'failed', {
                clientName: fullName,
                clientPhone: phoneNumber,
                orderCode: orderCode,
                product: product,
                instance: instance,
                amount: amount,
                errorMessage: sendResult.error
            });
            
            addDeliveryReport('venda_aprovada', sendResult.success ? 'success' : 'failed', {
                order_code: orderCode,
                product: product,
                instance: instance,
                error: sendResult.error
            });
            
        } else if (status === 'pending') {
            // PIX GERADO - NÃO ENVIA PARA N8N IMEDIATAMENTE
            addLog('info', `⏳ PIX GERADO - ${orderCode} | Produto: ${product} | Cliente: ${firstName} | Local: ${localizacao.localizacao_completa}`);
            
            // Cancela timeout anterior se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            // Obtém instância sticky para o cliente
            const instance = getInstanceForClient(phoneNumber);
            
            // Cria estado da conversa
            conversationState.set(phoneNumber, {
                order_code: orderCode,
                product: product,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                last_system_message: null,
                waiting_for_response: true,
                client_name: fullName,
                amount: amount,
                pix_url: pixUrl,
                billet_url: pixUrl,
                createdAt: new Date()
            });
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT PIX: ${orderCode} - Enviando PIX não pago`);
                pendingPixOrders.delete(orderCode);
                
                const eventData = {
                    event_type: 'pix_timeout',
                    produto: product,
                    instancia: instance,
                    evento_origem: 'pix',
                    cliente: {
                        nome: firstName,
                        telefone: phoneNumber,
                        nome_completo: fullName
                    },
                    pedido: {
                        codigo: orderCode,
                        valor: amount,
                        plano: planCode,
                        pix_url: pixUrl
                    },
                    cidade: localizacao.cidade,
                    estado: localizacao.estado,
                    regiao: localizacao.regiao,
                    ddd: dddCalculado,
                    localizacao_completa: localizacao.localizacao_completa,
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime(),
                    dados_originais: data
                };
                
                // ENVIA PARA N8N APÓS TIMEOUT
                const sendResult = await sendToN8N(eventData, 'pix_timeout');
                
                // Adiciona ao histórico
                addEventToHistory('pix_timeout', sendResult.success ? 'success' : 'failed', {
                    clientName: fullName,
                    clientPhone: phoneNumber,
                    orderCode: orderCode,
                    product: product,
                    instance: instance,
                    amount: amount,
                    errorMessage: sendResult.error
                });
                
                addDeliveryReport('pix_timeout', sendResult.success ? 'success' : 'failed', {
                    order_code: orderCode,
                    product: product,
                    instance: instance,
                    error: sendResult.error
                });
            }, PIX_TIMEOUT);
            
            // Armazena pedido pendente
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                product: product,
                instance: instance,
                phone: phoneNumber,
                first_name: firstName,
                full_name: fullName,
                amount: amount
            });
            
            // NÃO ENVIA pix_gerado para N8N
            addEventToHistory('pix_gerado', 'success', {
                clientName: fullName,
                clientPhone: phoneNumber,
                orderCode: orderCode,
                product: product,
                instance: instance,
                amount: amount
            });
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Perfect processado',
            order_code: orderCode,
            product: product,
            location: localizacao.localizacao_completa,
            instance: clientInstanceMap.has(phoneNumber) ? clientInstanceMap.get(phoneNumber).instance : null
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO Perfect webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook Kirvano (NOVO)
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        console.log('Webhook Kirvano recebido:', JSON.stringify(data, null, 2));
        
        // A estrutura da Kirvano pode variar - você precisa verificar
        const status = data.status || data.event_type;
        const productId = data.product_id || data.checkout_id || data.payment_link_id;
        const product = getProductByKirvanoId(productId);
        
        const customer = data.customer || {};
        const fullName = customer.name || customer.full_name || 'Cliente';
        const firstName = getFirstName(fullName);
        
        // Extrair telefone - a Kirvano pode enviar de formas diferentes
        let phoneNumber = '';
        if (customer.phone) {
            phoneNumber = normalizePhoneNumber(customer.phone);
        } else if (customer.phone_number) {
            phoneNumber = normalizePhoneNumber(customer.phone_number);
        } else if (customer.cellphone) {
            phoneNumber = normalizePhoneNumber(customer.cellphone);
        }
        
        const amount = data.amount || data.value || 0;
        const orderCode = data.id || data.transaction_id || data.order_id || 'KIRVANO-' + Date.now();
        const pixUrl = data.payment_url || data.pix_url || '';

        addLog('webhook_received', `Kirvano: ${orderCode} | Status: ${status} | Produto: ${product} | Cliente: ${firstName} | Fone: ${phoneNumber}`);

        if (status === 'approved' || status === 'paid' || status === 'complete') {
            // VENDA APROVADA
            addLog('info', `✅ VENDA APROVADA KIRVANO - ${orderCode} | Produto: ${product}`);
            
            // Cancela timeout se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
            }
            
            // Obtém instância sticky para o cliente
            const instance = getInstanceForClient(phoneNumber);
            
            // Cria/atualiza estado da conversa
            conversationState.set(phoneNumber, {
                order_code: orderCode,
                product: product,
                instance: instance,
                original_event: 'aprovada',
                response_count: 0,
                last_system_message: null,
                waiting_for_response: true,
                client_name: fullName,
                amount: amount,
                pix_url: '',
                billet_url: '',
                createdAt: new Date()
            });
            
            // Prepara dados para N8N
            const eventData = {
                event_type: 'venda_aprovada',
                produto: product,
                instancia: instance,
                evento_origem: 'aprovada',
                cliente: {
                    nome: firstName,
                    telefone: phoneNumber,
                    nome_completo: fullName
                },
                pedido: {
                    codigo: orderCode,
                    valor: amount
                },
                timestamp: new Date().toISOString(),
                brazil_time: getBrazilTime(),
                dados_originais: data
            };
            
            await sendToN8N(eventData, 'venda_aprovada');
            
        } else if (status === 'pending' || status === 'waiting_payment') {
            // PAGAMENTO PENDENTE
            addLog('info', `⏳ PAGAMENTO PENDENTE KIRVANO - ${orderCode} | Produto: ${product}`);
            
            const instance = getInstanceForClient(phoneNumber);
            
            // Cria estado da conversa
            conversationState.set(phoneNumber, {
                order_code: orderCode,
                product: product,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                last_system_message: null,
                waiting_for_response: true,
                client_name: fullName,
                amount: amount,
                pix_url: pixUrl,
                billet_url: pixUrl,
                createdAt: new Date()
            });
            
            // Timeout de 7 minutos
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT KIRVANO: ${orderCode}`);
                pendingPixOrders.delete(orderCode);
                
                const eventData = {
                    event_type: 'pix_timeout',
                    produto: product,
                    instancia: instance,
                    evento_origem: 'pix',
                    cliente: {
                        nome: firstName,
                        telefone: phoneNumber
                    },
                    pedido: {
                        codigo: orderCode,
                        valor: amount,
                        pix_url: pixUrl
                    },
                    timestamp: new Date().toISOString()
                };
                
                await sendToN8N(eventData, 'pix_timeout');
            }, PIX_TIMEOUT);
            
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                product: product,
                instance: instance,
                phone: phoneNumber,
                first_name: firstName,
                full_name: fullName,
                amount: amount
            });
        }

        res.status(200).json({ success: true });
        
    } catch (error) {
        addLog('error', `❌ ERRO Kirvano webhook: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para normalizar número de telefone (padroniza formato)
function normalizePhoneNumber(phone) {
    // Remove tudo que não é número
    let cleaned = phone.replace(/\D/g, '');
    
    // Se começa com 55 (Brasil)
    if (cleaned.startsWith('55')) {
        // Pega DDD (posições 2-3 ou 2-4 dependendo do caso)
        const withoutCountry = cleaned.substring(2);
        
        // Se tem 11 dígitos (DDD + 9 + número)
        if (withoutCountry.length === 11) {
            const ddd = withoutCountry.substring(0, 2);
            const rest = withoutCountry.substring(2);
            
            // Se o resto começa com 9 e tem 9 dígitos, remove o 9
            if (rest.startsWith('9') && rest.length === 9) {
                cleaned = '55' + ddd + rest.substring(1);
            }
        }
        // Se tem 12 dígitos (DDD com 9 extra + 9 + número)
        else if (withoutCountry.length === 12) {
            // Caso especial: 759 ao invés de 75
            const possibleDDD = withoutCountry.substring(0, 3);
            if (possibleDDD.endsWith('9')) {
                // Remove o 9 do DDD
                const realDDD = possibleDDD.substring(0, 2);
                const rest = withoutCountry.substring(3);
                cleaned = '55' + realDDD + rest;
            }
        }
    }
    
    console.log(`📱 Normalização: ${phone} → ${cleaned}`);
    return cleaned;
}

// Função para verificar se números são equivalentes
function phoneNumbersMatch(phone1, phone2) {
    const norm1 = normalizePhoneNumber(phone1);
    const norm2 = normalizePhoneNumber(phone2);
    console.log(`📞 Comparando: ${norm1} === ${norm2} ? ${norm1 === norm2}`);
    return norm1 === norm2;
}

// Função para encontrar estado por número (com normalização)
function findConversationState(phoneNumber) {
    const normalizedSearch = normalizePhoneNumber(phoneNumber);
    console.log(`🔍 Buscando estado para número normalizado: ${normalizedSearch}`);
    
    for (const [phone, state] of conversationState.entries()) {
        const normalizedStored = normalizePhoneNumber(phone);
        console.log(`  Comparando com: ${phone} (normalizado: ${normalizedStored})`);
        if (normalizedStored === normalizedSearch) {
            console.log(`  ✅ MATCH encontrado!`);
            return { phone, state };
        }
    }
    
    console.log(`  ❌ Nenhum match encontrado`);
    return null;
}

// Webhook Evolution API
app.post('/webhook/evolution', async (req, res) => {
    try {
        // LOG COMPLETO DO PAYLOAD PARA DEBUG
        console.log('========================================');
        console.log('EVOLUTION WEBHOOK RECEBIDO:', getBrazilTime());
        console.log('PAYLOAD COMPLETO:', JSON.stringify(req.body, null, 2));
        console.log('========================================');
        
        const data = req.body;
        
        // Adiciona ao log do sistema também
        addLog('evolution_raw', `Payload Evolution recebido`, { 
            raw_body: req.body,
            headers: req.headers 
        });
        
        // Verifica se tem a estrutura esperada
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            console.log('⚠️ Estrutura não esperada - messageData ou key ausente');
            addLog('warning', `Evolution: estrutura inesperada`, { body: req.body });
            return res.status(200).json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || '';
        
        // CORREÇÃO: Usar apikey ao invés de instanceId para identificar a instância
        const apiKey = data.apikey;
        const instanceName = data.instance;
        
        // Logs detalhados dos campos extraídos
        console.log('📱 Remote JID:', remoteJid);
        console.log('👤 From Me:', fromMe, '(tipo:', typeof fromMe, ')');
        console.log('💬 Message Content:', messageContent);
        console.log('🏷️ Instance Name:', instanceName);
        console.log('🔑 API Key:', apiKey);
        
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        // Verifica se a instância é conhecida
        const knownInstance = INSTANCES.find(i => i.id === apiKey || i.name === instanceName);
        const finalInstanceName = knownInstance ? knownInstance.name : instanceName || 'UNKNOWN';
        
        addLog('evolution_webhook', `Evolution: ${clientNumber} | FromMe: ${fromMe} | Instância: ${finalInstanceName}`);
        
        // Busca estado com normalização de número
        const conversationMatch = findConversationState(clientNumber);
        
        // PARA TESTES: Se não existe estado, criar um temporário
        if (!conversationMatch && messageContent.toLowerCase().includes('teste')) {
            console.log('🧪 MODO TESTE: Criando estado temporário para testar resposta');
            conversationState.set(clientNumber, {
                order_code: 'TESTE-' + Date.now(),
                product: 'TESTE',
                instance: finalInstanceName,
                original_event: 'teste',
                response_count: 0,
                last_system_message: new Date(),
                waiting_for_response: true,
                client_name: messageData.pushName || 'Cliente Teste',
                createdAt: new Date()
            });
            addLog('info', `🧪 Estado de teste criado para ${clientNumber}`);
        }
        
        // Busca novamente após possível criação de teste
        const finalMatch = conversationMatch || findConversationState(clientNumber);
        
        // Se não existe estado de conversa, ignora mensagem
        if (!finalMatch) {
            console.log(`❌ Cliente ${clientNumber} NÃO está no conversationState`);
            addLog('info', `❓ Cliente ${clientNumber} não encontrado no estado de conversa - mensagem ignorada`);
            return res.status(200).json({ success: true, message: 'Cliente não encontrado' });
        }
        
        const { phone: matchedPhone, state: clientState } = finalMatch;
        console.log(`✅ Estado encontrado para ${matchedPhone}:`, JSON.stringify(clientState, null, 2));
        
        if (fromMe) {
            // MENSAGEM ENVIADA PELO SISTEMA
            clientState.last_system_message = new Date();
            clientState.waiting_for_response = true;
            addLog('info', `📤 Sistema enviou mensagem para ${clientNumber} via ${finalInstanceName}`);
            
            // Adiciona ao histórico local
            addEventToHistory('mensagem_enviada', 'success', {
                clientName: clientState.client_name || 'Cliente',
                clientPhone: clientNumber,
                orderCode: clientState.order_code,
                product: clientState.product,
                instance: finalInstanceName,
                responseContent: messageContent.substring(0, 100)
            });
            
        } else {
            // RESPOSTA DO CLIENTE
            console.log('📨 Mensagem do cliente detectada');
            console.log('⏳ Waiting for response:', clientState.waiting_for_response);
            console.log('🔢 Response count:', clientState.response_count);
            
            // SIMPLIFICADO: Se é a primeira resposta, envia para N8N
            if (clientState.response_count === 0) {
                // APENAS A PRIMEIRA RESPOSTA
                clientState.response_count = 1;
                clientState.waiting_for_response = false;
                
                addLog('info', `📥 PRIMEIRA RESPOSTA do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
                console.log('🚀 ENVIANDO RESPOSTA_01 PARA N8N');
                
                // Extrai apenas o primeiro nome
                const fullName = clientState.client_name || messageData.pushName || 'Cliente';
                const firstName = fullName.split(' ')[0];
                
                // ========== CALCULAR LOCALIZAÇÃO PARA RESPOSTA ==========
                const localizacao = getLocationByDDD(clientNumber);
                const dddCalculado = clientNumber.length > 4 && clientNumber.startsWith('55') 
                    ? clientNumber.substring(2, 4) 
                    : clientNumber.substring(0, 2);
                
                const eventData = {
                    event_type: 'resposta_01',
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event,
                    cliente: {
                        telefone: clientNumber,
                        nome: firstName
                    },
                    resposta: {
                        numero: 1,
                        conteudo: messageContent,
                        timestamp: new Date().toISOString(),
                        brazil_time: getBrazilTime()
                    },
                    pedido: {
                        codigo: clientState.order_code,
                        valor: clientState.amount || 0,
                        billet_url: clientState.pix_url || clientState.billet_url || ''
                    },
                    cidade: localizacao.cidade,
                    estado: localizacao.estado,
                    regiao: localizacao.regiao,
                    ddd: dddCalculado,
                    localizacao_completa: localizacao.localizacao_completa,
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime(),
                    dados_originais: data
                };
                
                // ENVIA PARA N8N
                const sendResult = await sendToN8N(eventData, 'resposta_01');
                console.log('📤 Resultado do envio para N8N:', sendResult);
                
                // Adiciona ao histórico
                addEventToHistory('resposta_cliente', sendResult.success ? 'success' : 'failed', {
                    clientName: clientState.client_name || 'Cliente',
                    clientPhone: clientNumber,
                    orderCode: clientState.order_code,
                    product: clientState.product,
                    instance: clientState.instance,
                    responseContent: messageContent,
                    errorMessage: sendResult.error
                });
                
                addDeliveryReport('resposta_01', sendResult.success ? 'success' : 'failed', {
                    client_number: clientNumber,
                    product: clientState.product,
                    instance: clientState.instance,
                    error: sendResult.error
                });
                
                conversationState.set(matchedPhone, clientState);
                
            } else if (clientState.response_count > 0) {
                // IGNORA RESPOSTAS ADICIONAIS
                addLog('info', `📝 Resposta adicional IGNORADA do cliente ${clientNumber} (já enviou resposta_01)`);
                console.log('⚠️ Resposta adicional ignorada - já tem resposta_01');
            } else {
                addLog('info', `📝 Mensagem do cliente ${clientNumber} antes do sistema enviar mensagem - IGNORADA`);
                console.log('⚠️ Mensagem antes do sistema enviar - ignorada');
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Evolution processado',
            client_number: clientNumber,
            instance: finalInstanceName,
            from_me: fromMe
        });
        
    } catch (error) {
        console.error('❌ ERRO NO WEBHOOK EVOLUTION:', error);
        addLog('error', `❌ ERRO Evolution webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar dados para N8N (URL fixa)
async function sendToN8N(eventData, eventType) {
    try {
        addLog('info', `🚀 Enviando para N8N: ${eventType} | URL: ${N8N_WEBHOOK_URL}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Webhook-Cerebro-Evolution/1.0'
            },
            timeout: 15000
        });
        
        addLog('webhook_sent', `✅ Enviado para N8N: ${eventType} | Status: ${response.status}`);
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `❌ ERRO N8N: ${eventType} | ${errorMessage}`);
        
        return { success: false, error: errorMessage };
    }
}

// API Endpoints (mantidos iguais)

// Status principal
app.get('/status', (req, res) => {
    const pendingList = Array.from(pendingPixOrders.entries()).map(([code, order]) => ({
        code: code,
        product: order.product,
        instance: order.instance,
        phone: order.phone,
        first_name: order.first_name,
        full_name: order.full_name,
        amount: order.amount,
        created_at: order.timestamp,
        created_at_brazil: new Date(order.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        remaining_time: Math.max(0, PIX_TIMEOUT - (new Date() - order.timestamp))
    }));
    
    const conversationList = Array.from(conversationState.entries()).map(([phone, state]) => ({
        phone: phone,
        order_code: state.order_code,
        product: state.product,
        instance: state.instance,
        response_count: state.response_count,
        waiting_for_response: state.waiting_for_response,
        original_event: state.original_event,
        client_name: state.client_name,
        created_at: state.createdAt,
        created_at_brazil: state.createdAt ? state.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : null
    }));
    
    const reportStats = {
        total_events: deliveryReports.length,
        successful: deliveryReports.filter(r => r.status === 'success').length,
        failed: deliveryReports.filter(r => r.status === 'failed').length,
        venda_aprovada: deliveryReports.filter(r => r.type === 'venda_aprovada').length,
        pix_timeout: deliveryReports.filter(r => r.type === 'pix_timeout').length,
        resposta_01: deliveryReports.filter(r => r.type === 'resposta_01').length
    };
    
    const recentLogs = systemLogs.slice(-100);
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        uptime: process.uptime(),
        pending_pix_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        client_instance_mappings: clientInstanceMap.size,
        orders: pendingList,
        conversations: conversationList,
        delivery_reports: reportStats,
        system_stats: systemStats,
        logs_last_hour: recentLogs,
        evolution_api_url: EVOLUTION_API_URL,
        n8n_webhook_url: N8N_WEBHOOK_URL,
        data_retention: '24 hours',
        pix_timeout: '7 minutes'
    });
});

// Histórico de eventos
app.get('/events', (req, res) => {
    const { type, status, date, limit = 100 } = req.query;
    
    let filteredEvents = eventHistory;
    
    if (type) {
        filteredEvents = filteredEvents.filter(e => e.type === type);
    }
    
    if (status) {
        filteredEvents = filteredEvents.filter(e => e.status === status);
    }
    
    if (date) {
        filteredEvents = filteredEvents.filter(e => e.date === date);
    }
    
    res.json({
        total: filteredEvents.length,
        brazil_time: getBrazilTime(),
        events: filteredEvents.slice(0, parseInt(limit))
    });
});

// Estatísticas do sistema
app.get('/stats', (req, res) => {
    const uptime = process.uptime();
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);
    
    res.json({
        system: {
            status: 'online',
            uptime: `${uptimeHours}h ${uptimeMinutes}m`,
            startTime: systemStats.startTime.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
            currentTime: getBrazilTime()
        },
        events: {
            total: systemStats.totalEvents,
            successful: systemStats.successfulEvents,
            failed: systemStats.failedEvents,
            successRate: systemStats.totalEvents > 0 
                ? ((systemStats.successfulEvents / systemStats.totalEvents) * 100).toFixed(2) + '%'
                : '0%'
        },
        current: {
            pendingPix: pendingPixOrders.size,
            activeConversations: conversationState.size,
            instanceMappings: clientInstanceMap.size
        },
        history: {
            eventsLast24h: eventHistory.length,
            totalEvents: eventHistory.length
        },
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Servir arquivo HTML
app.get('/', (req, res) => {
    res.send(getHTMLContent());
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        pending_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        total_events: eventHistory.length,
        uptime: process.uptime(),
        features: {
            localizacao: 'ATIVA - Baseada no CODE v2.7',
            instancias_fixas: 'ATIVA',
            anti_duplicata: 'ATIVA',
            timeout_pix: '7 minutos',
            kirvano: 'ATIVO'
        },
        config: {
            n8n_webhook_url: N8N_WEBHOOK_URL,
            data_retention: '24 hours',
            pix_timeout: '7 minutes'
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🧠 CÉREBRO DE ATENDIMENTO v3.0 COM KIRVANO iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect: http://localhost:${PORT}/webhook/perfect`);
    addLog('info', `📱 Webhook Kirvano: http://localhost:${PORT}/webhook/kirvano`);
    addLog('info', `📱 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    addLog('info', `🖥️ Painel de Controle: http://localhost:${PORT}`);
    addLog('info', `📊 API Eventos: http://localhost:${PORT}/events`);
    addLog('info', `📈 API Estatísticas: http://localhost:${PORT}/stats`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    addLog('info', `🤖 Evolution API: ${EVOLUTION_API_URL}`);
    addLog('info', `🔄 Kirvano: ATIVO com mapeamento de produtos`);
    addLog('info', `🗺️ Sistema de Localização: ATIVO`);
    addLog('info', `⏰ Timezone: America/Sao_Paulo (Horário de Brasília)`);
    
    console.log(`\n🧠 CÉREBRO DE ATENDIMENTO v3.0 COM KIRVANO ATIVO`);
    console.log(`================================================================================`);
    console.log(`📡 Webhooks configurados:`);
    console.log(`   Perfect Pay: http://localhost:${PORT}/webhook/perfect`);
    console.log(`   Kirvano: http://localhost:${PORT}/webhook/kirvano`);
    console.log(`   Evolution: http://localhost:${PORT}/webhook/evolution`);
    console.log(`🎯 N8N: ${N8N_WEBHOOK_URL}`);
    console.log(`📊 Painel: http://localhost:${PORT}`);
    console.log(`🔄 KIRVANO: ATIVO com ${Object.keys(PRODUCT_MAPPING).length} produtos mapeados`);
    console.log(`⏰ Horário: ${getBrazilTime()}`);
    console.log(`================================================================================\n`);
});

// A função getHTMLContent() permanece a mesma - muito grande para incluir aqui
// Mas mantém o HTML completo do seu painel
function getHTMLContent() {
    // ... (o mesmo HTML que você já tinha)
    // Esta função é muito longa, mas mantém exatamente o mesmo conteúdo
    return `<!DOCTYPE html>...`; // Seu HTML completo aqui
}
