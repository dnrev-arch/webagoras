const express = require('express');
const axios = require('axios');
const app = express();

// ========== CONFIGURAÇÕES PRINCIPAIS ==========
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/webhookagoras';
const EVOLUTION_API_URL = 'https://evo.flowzap.fun';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const DATA_RETENTION_TIME = 24 * 60 * 60 * 1000; // 24 horas
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos

// ========== CONFIGURAÇÕES DAS FUNCIONALIDADES ==========
const FEATURES = {
    VCARD_ENABLED: true,
    FACEBOOK_CAPI_ENABLED: true,
    FACEBOOK_MARKETING_API_ENABLED: true,
    GOOGLE_CONTACTS_ENABLED: false, // Ativar após configurar OAuth2
    ADVANCED_DASHBOARD: true,
    INSTANCE_STATUS_CHECK: true
};

// ========== CONFIGURAÇÃO FACEBOOK ==========
const FACEBOOK_CONFIG = {
    ACCESS_TOKEN: process.env.FB_ACCESS_TOKEN || 'EAAIbZCP5fkVYBPX0zNqrXkLjKjRW9xdPoDZAIG4JBNQZBse4xph0RI9tomOD2WLbUb2E29iHrS8EysjcxFM19rCCxWydM9yTLalzZBjwe1fvAaIVoAZCPbNhTQG1PFNlP1JlUWrIJYvPRXJpWdB4a6IFeRTRCt1bWbXEaAMXgyaAWZB5QK6zHFeEdyuwCRcKhbNgZDZD',
    PIXEL_ID: '1041071206927840',
    AD_ACCOUNTS: [
        { id: '1043755320841524', name: 'Conta 02' },
        { id: '1006880451345440', name: 'Conta 03' },
        { id: '1011060770921276', name: 'Conta 01 BM 02' }
    ],
    TEST_EVENT_CODE: process.env.FB_TEST_CODE || ''
};

// ========== CONFIGURAÇÃO GOOGLE OAUTH2 (Preparado) ==========
const GOOGLE_CONFIG = {
    CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '', // Criar no Google Cloud Console
    CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '', // Criar no Google Cloud Console
    REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback',
    SCOPES: ['https://www.googleapis.com/auth/contacts']
};

// ========== ARMAZENAMENTO EM MEMÓRIA ==========
let pendingPixOrders = new Map();
let systemLogs = [];
let clientInstanceMap = new Map();
let conversationState = new Map();
let deliveryReports = [];
let eventHistory = [];
let instanceCounter = 0;
let systemStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    startTime: new Date()
};

// Métricas por instância
let instanceMetrics = new Map();

// Cache de métricas do Facebook (atualizado a cada 5 minutos)
let facebookMetricsCache = {
    lastUpdate: null,
    data: null
};

// Status das instâncias Evolution
let instanceStatusCache = new Map();

// ========== MAPEAMENTO DE PRODUTOS ==========
const PRODUCT_MAPPING = {
    'PPLQQMOVD': 'FAB',
    'PPLQQMOVH': 'FAB', 
    'PPLQQMOVG': 'FAB',
    'PPLQQN0AL': 'NAT',
    'PPLQQN7T4': 'CS',
    'PPLQQMBIL': 'CS'
};

// ========== INSTÂNCIAS DISPONÍVEIS ==========
const INSTANCES = [
    { name: 'G01', id: '584F8ACCAA48-488D-A26E-E75E1A5B2994', displayName: 'F01' },
    { name: 'G02', id: '2E2C41AB88F9-4356-B866-9ADA88530FD0', displayName: 'G02' },
    { name: 'G03', id: '9AFECAC9683B-4611-8C51-933447B70905', displayName: 'GABY03' },
    { name: 'G05', id: '118E0162F12C-4841-ADD6-33E11DDB341A', displayName: 'GABY05' },
    { name: 'G06', id: '4AC271E7BBEA-4A2B-BB2D-3583BDE4AE1E', displayName: 'G06' },
    { name: 'G07T', id: 'E28170C3375C-4116-8723-144CC9B90994', displayName: 'GABY07' },
    { name: 'G08', id: 'A63C380B277D-4A5E-9ECD-48710291E5A6', displayName: 'G08' },
    { name: 'G09', id: 'E667206D3C72-4F8B-AD10-F933F273A39B', displayName: 'G09' },
    { name: 'G10', id: 'D6932E02E658-40BD-9784-8932841CCFA4', displayName: 'G01' },
];

app.use(express.json());

// ========== FUNÇÕES DE DATA/HORA ==========
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

// ========== FUNÇÃO DE LOCALIZAÇÃO (SEM SAUDAÇÕES) ==========
function getLocationByDDD(telefone) {
    if (!telefone) return { cidade: 'Brasil', estado: '', regiao: 'Brasil', localizacao_completa: 'Brasil' };
    
    var numeroLimpo = telefone.replace(/\D/g, '');
    var ddd = '';
    
    if (numeroLimpo.length > 4 && numeroLimpo.indexOf("55") === 0) {
        ddd = numeroLimpo.substring(2, 4);
    } else if (numeroLimpo.length >= 2) {
        ddd = numeroLimpo.substring(0, 2);
    }
    
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
    
    localizacao.localizacao_completa = localizacao.estado ? 
        localizacao.cidade + '/' + localizacao.estado : 
        localizacao.cidade;
    
    return localizacao;
}

// ========== FUNÇÕES FACEBOOK ==========

// Hash para privacidade (Facebook requer dados hasheados)
function hashString(str) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(str).digest('hex');
}

function hashPhone(phone) {
    const cleaned = phone.replace(/\D/g, '');
    return hashString(cleaned);
}

// Enviar evento para Facebook CAPI
async function sendFacebookEvent(eventName, eventData) {
    if (!FEATURES.FACEBOOK_CAPI_ENABLED || !FACEBOOK_CONFIG.ACCESS_TOKEN || !FACEBOOK_CONFIG.PIXEL_ID) {
        return { success: false, message: 'Facebook CAPI não configurado' };
    }
    
    try {
        const fbEvent = {
            data: [{
                event_name: eventName,
                event_time: Math.floor(Date.now() / 1000),
                event_source_url: 'https://seu-dominio.com',
                user_data: {
                    ph: eventData.phone ? hashPhone(eventData.phone) : undefined,
                    fn: eventData.firstName ? hashString(eventData.firstName.toLowerCase()) : undefined,
                    ct: eventData.city ? hashString(eventData.city.toLowerCase()) : undefined,
                    st: eventData.state ? hashString(eventData.state.toLowerCase()) : undefined,
                    country: hashString('br'),
                    external_id: eventData.externalId ? hashString(eventData.externalId) : undefined
                },
                custom_data: {
                    currency: 'BRL',
                    value: eventData.value || 0,
                    content_name: eventData.product,
                    content_category: 'Product',
                    content_ids: [eventData.orderCode],
                    contents: [{
                        id: eventData.orderCode,
                        quantity: 1
                    }]
                },
                action_source: 'website'
            }],
            ...(FACEBOOK_CONFIG.TEST_EVENT_CODE && { test_event_code: FACEBOOK_CONFIG.TEST_EVENT_CODE })
        };
        
        const url = `https://graph.facebook.com/v18.0/${FACEBOOK_CONFIG.PIXEL_ID}/events`;
        
        const response = await axios.post(url, fbEvent, {
            params: {
                access_token: FACEBOOK_CONFIG.ACCESS_TOKEN
            }
        });
        
        return { success: true, data: response.data };
    } catch (error) {
        addLog('error', `Erro ao enviar evento Facebook: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// Buscar métricas do Facebook Marketing API
async function fetchFacebookMetrics() {
    if (!FEATURES.FACEBOOK_MARKETING_API_ENABLED || !FACEBOOK_CONFIG.ACCESS_TOKEN) {
        return null;
    }
    
    // Cache de 5 minutos
    if (facebookMetricsCache.lastUpdate && 
        (Date.now() - facebookMetricsCache.lastUpdate) < 5 * 60 * 1000) {
        return facebookMetricsCache.data;
    }
    
    try {
        const today = new Date().toISOString().split('T')[0];
        const metrics = [];
        
        for (const account of FACEBOOK_CONFIG.AD_ACCOUNTS) {
            const url = `https://graph.facebook.com/v18.0/act_${account.id}/insights`;
            
            const response = await axios.get(url, {
                params: {
                    access_token: FACEBOOK_CONFIG.ACCESS_TOKEN,
                    fields: 'spend,impressions,clicks,cpc,cpm,ctr,conversions,conversion_values,cost_per_conversion,purchase_roas',
                    date_preset: 'today',
                    level: 'account'
                }
            });
            
            if (response.data && response.data.data && response.data.data[0]) {
                const data = response.data.data[0];
                metrics.push({
                    account_id: account.id,
                    account_name: account.name,
                    date: today,
                    spend: parseFloat(data.spend || 0),
                    impressions: parseInt(data.impressions || 0),
                    clicks: parseInt(data.clicks || 0),
                    cpc: parseFloat(data.cpc || 0),
                    cpm: parseFloat(data.cpm || 0),
                    ctr: parseFloat(data.ctr || 0),
                    conversions: parseInt(data.conversions || 0),
                    conversion_value: parseFloat(data.conversion_values?.value || 0),
                    cost_per_conversion: parseFloat(data.cost_per_conversion?.value || 0),
                    roas: parseFloat(data.purchase_roas?.[0]?.value || 0)
                });
            }
        }
        
        // Calcular totais
        const totals = {
            total_spend: metrics.reduce((sum, m) => sum + m.spend, 0),
            total_impressions: metrics.reduce((sum, m) => sum + m.impressions, 0),
            total_clicks: metrics.reduce((sum, m) => sum + m.clicks, 0),
            total_conversions: metrics.reduce((sum, m) => sum + m.conversions, 0),
            total_conversion_value: metrics.reduce((sum, m) => sum + m.conversion_value, 0),
            avg_cpc: 0,
            avg_cpm: 0,
            avg_ctr: 0,
            overall_roas: 0
        };
        
        if (totals.total_clicks > 0) {
            totals.avg_cpc = totals.total_spend / totals.total_clicks;
        }
        if (totals.total_impressions > 0) {
            totals.avg_cpm = (totals.total_spend / totals.total_impressions) * 1000;
            totals.avg_ctr = (totals.total_clicks / totals.total_impressions) * 100;
        }
        if (totals.total_spend > 0) {
            totals.overall_roas = totals.total_conversion_value / totals.total_spend;
        }
        
        const result = {
            metrics_by_account: metrics,
            totals: totals,
            last_update: new Date().toISOString()
        };
        
        // Atualizar cache
        facebookMetricsCache = {
            lastUpdate: Date.now(),
            data: result
        };
        
        return result;
    } catch (error) {
        addLog('error', `Erro ao buscar métricas Facebook: ${error.message}`);
        return null;
    }
}

// ========== VERIFICAÇÃO DE STATUS DAS INSTÂNCIAS ==========
async function checkInstanceStatus(instanceName) {
    if (!FEATURES.INSTANCE_STATUS_CHECK) {
        return { online: true, message: 'Verificação desabilitada' };
    }
    
    const instance = INSTANCES.find(i => i.name === instanceName);
    if (!instance) {
        return { online: false, message: 'Instância não encontrada' };
    }
    
    try {
        // Verificar cache (1 minuto)
        const cached = instanceStatusCache.get(instanceName);
        if (cached && (Date.now() - cached.timestamp) < 60000) {
            return cached.status;
        }
        
        // Fazer requisição para Evolution API
        const response = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${instance.name}`, {
            headers: {
                'apikey': instance.id
            },
            timeout: 5000
        });
        
        const status = {
            online: response.data?.state === 'open',
            state: response.data?.state || 'unknown',
            message: response.data?.message || ''
        };
        
        // Atualizar cache
        instanceStatusCache.set(instanceName, {
            status: status,
            timestamp: Date.now()
        });
        
        return status;
    } catch (error) {
        return { online: false, message: error.message };
    }
}

// Verificar todas as instâncias
async function checkAllInstancesStatus() {
    const statuses = {};
    for (const instance of INSTANCES) {
        const status = await checkInstanceStatus(instance.name);
        statuses[instance.name] = status;
    }
    return statuses;
}

// ========== FUNÇÕES GOOGLE CONTACTS (Preparado para OAuth2) ==========

// NOTA: Para funcionar completamente, você precisa:
// 1. Criar projeto no Google Cloud Console
// 2. Ativar Google People API
// 3. Criar credenciais OAuth2
// 4. Adicionar CLIENT_ID e CLIENT_SECRET nas variáveis de ambiente

function generateGoogleAuthUrl() {
    if (!GOOGLE_CONFIG.CLIENT_ID) {
        return null;
    }
    
    const params = new URLSearchParams({
        client_id: GOOGLE_CONFIG.CLIENT_ID,
        redirect_uri: GOOGLE_CONFIG.REDIRECT_URI,
        response_type: 'code',
        scope: GOOGLE_CONFIG.SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent'
    });
    
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCodeForTokens(code) {
    try {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            code: code,
            client_id: GOOGLE_CONFIG.CLIENT_ID,
            client_secret: GOOGLE_CONFIG.CLIENT_SECRET,
            redirect_uri: GOOGLE_CONFIG.REDIRECT_URI,
            grant_type: 'authorization_code'
        });
        
        return response.data;
    } catch (error) {
        addLog('error', `Erro ao trocar código por token: ${error.message}`);
        return null;
    }
}

async function createGoogleContact(accessToken, contactData) {
    try {
        const response = await axios.post(
            'https://people.googleapis.com/v1/people:createContact',
            {
                names: [{
                    givenName: contactData.firstName,
                    familyName: contactData.lastName || ''
                }],
                phoneNumbers: [{
                    value: contactData.phone,
                    type: 'mobile'
                }],
                organizations: [{
                    name: contactData.company || 'Cliente'
                }]
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return { success: true, data: response.data };
    } catch (error) {
        addLog('error', `Erro ao criar contato Google: ${error.message}`);
        return { success: false, error: error.message };
    }
}

// ========== FUNÇÕES DE GERENCIAMENTO ==========

// Gerar vCard
function generateVCard(name, phone, company = 'Suporte') {
    if (!FEATURES.VCARD_ENABLED) {
        return null;
    }
    
    const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${name}
ORG:${company}
TEL;TYPE=CELL:${phone}
END:VCARD`;
    
    return Buffer.from(vcard).toString('base64');
}

// Atualizar métricas por instância
function updateInstanceMetrics(instanceName, metricType, value = 1) {
    if (!FEATURES.ADVANCED_DASHBOARD) return;
    
    if (!instanceMetrics.has(instanceName)) {
        instanceMetrics.set(instanceName, {
            messagesSent: 0,
            responsesReceived: 0,
            conversions: 0,
            pixGenerated: 0,
            pixTimeout: 0,
            lastActivity: new Date(),
            activeConversations: 0,
            totalRevenue: 0,
            dailyStats: {
                date: getBrazilDate(),
                leads: 0,
                sales: 0
            }
        });
    }
    
    const metrics = instanceMetrics.get(instanceName);
    
    // Reset daily stats if date changed
    if (metrics.dailyStats.date !== getBrazilDate()) {
        metrics.dailyStats = {
            date: getBrazilDate(),
            leads: 0,
            sales: 0
        };
    }
    
    switch(metricType) {
        case 'message_sent':
            metrics.messagesSent += value;
            break;
        case 'response_received':
            metrics.responsesReceived += value;
            metrics.dailyStats.leads += value;
            break;
        case 'conversion':
            metrics.conversions += value;
            metrics.dailyStats.sales += value;
            break;
        case 'pix_generated':
            metrics.pixGenerated += value;
            break;
        case 'pix_timeout':
            metrics.pixTimeout += value;
            break;
        case 'revenue':
            metrics.totalRevenue += value;
            break;
        case 'active_conversation':
            metrics.activeConversations = value;
            break;
    }
    
    metrics.lastActivity = new Date();
    instanceMetrics.set(instanceName, metrics);
}

// Adicionar evento ao histórico
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
    
    systemStats.totalEvents++;
    if (status === 'success') {
        systemStats.successfulEvents++;
    } else if (status === 'failed') {
        systemStats.failedEvents++;
    }
    
    return event;
}

// Adicionar logs
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

// Adicionar relatório de entrega
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

// Obter instância para cliente (sticky)
function getInstanceForClient(clientNumber) {
    if (clientInstanceMap.has(clientNumber)) {
        const mapping = clientInstanceMap.get(clientNumber);
        addLog('info', `✅ Cliente ${clientNumber} mantido na instância ${mapping.instance}`);
        return mapping.instance;
    }
    
    const instance = INSTANCES[instanceCounter % INSTANCES.length];
    instanceCounter++;
    
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

// Limpeza de dados antigos
function cleanupOldData() {
    const now = Date.now();
    const cutoffTime = now - DATA_RETENTION_TIME;
    
    const beforeEventCount = eventHistory.length;
    eventHistory = eventHistory.filter(e => new Date(e.timestamp).getTime() > cutoffTime);
    
    const beforeConvCount = conversationState.size;
    for (const [phone, state] of conversationState.entries()) {
        if (state.createdAt && state.createdAt.getTime() < cutoffTime) {
            conversationState.delete(phone);
        }
    }
    
    const beforeMapCount = clientInstanceMap.size;
    for (const [phone, mapping] of clientInstanceMap.entries()) {
        if (mapping.createdAt && mapping.createdAt.getTime() < cutoffTime) {
            clientInstanceMap.delete(phone);
        }
    }
    
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > cutoffTime);
    deliveryReports = deliveryReports.filter(report => new Date(report.timestamp).getTime() > cutoffTime);
    
    addLog('cleanup', `Limpeza executada: ${beforeEventCount - eventHistory.length} eventos, ${beforeConvCount - conversationState.size} conversas, ${beforeMapCount - clientInstanceMap.size} mapeamentos removidos`);
}

setInterval(cleanupOldData, CLEANUP_INTERVAL);

// ========== WEBHOOKS ==========

// Webhook Perfect Pay
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
        
        const localizacao = getLocationByDDD(phoneNumber);
        const dddCalculado = phoneNumber.length > 4 && phoneNumber.startsWith('55') 
            ? phoneNumber.substring(2, 4) 
            : phoneNumber.substring(0, 2);
        
        addLog('webhook_received', `Perfect: ${orderCode} | Status: ${status} | Produto: ${product} | Cliente: ${firstName} | Fone: ${phoneNumber} | Local: ${localizacao.localizacao_completa}`);
        
        if (status === 'approved') {
            addLog('info', `✅ VENDA APROVADA - ${orderCode} | Produto: ${product} | Local: ${localizacao.localizacao_completa}`);
            
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ PIX pendente removido: ${orderCode}`);
            }
            
            const instance = getInstanceForClient(phoneNumber);
            
            updateInstanceMetrics(instance, 'conversion', 1);
            updateInstanceMetrics(instance, 'revenue', amount);
            
            await sendFacebookEvent('Purchase', {
                phone: phoneNumber,
                firstName: firstName,
                city: localizacao.cidade,
                state: localizacao.estado,
                value: amount,
                product: product,
                orderCode: orderCode,
                externalId: phoneNumber
            });
            
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
                    vcard_sent: false,
                    createdAt: new Date()
                });
            } else {
                const state = conversationState.get(phoneNumber);
                state.original_event = 'aprovada';
                state.instance = instance;
                state.waiting_for_response = true;
                state.amount = amount;
            }
            
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
            
            const sendResult = await sendToN8N(eventData, 'venda_aprovada');
            
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
            addLog('info', `⏳ PIX GERADO - ${orderCode} | Produto: ${product} | Cliente: ${firstName} | Local: ${localizacao.localizacao_completa}`);
            
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            const instance = getInstanceForClient(phoneNumber);
            
            updateInstanceMetrics(instance, 'pix_generated', 1);
            
            await sendFacebookEvent('InitiateCheckout', {
                phone: phoneNumber,
                firstName: firstName,
                city: localizacao.cidade,
                state: localizacao.estado,
                value: amount,
                product: product,
                orderCode: orderCode,
                externalId: phoneNumber
            });
            
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
                vcard_sent: false,
                createdAt: new Date()
            });
            
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT PIX: ${orderCode} - Enviando PIX não pago`);
                pendingPixOrders.delete(orderCode);
                
                updateInstanceMetrics(instance, 'pix_timeout', 1);
                
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
                
                const sendResult = await sendToN8N(eventData, 'pix_timeout');
                
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

// Normalizar número de telefone
function normalizePhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    if (cleaned.startsWith('55')) {
        const withoutCountry = cleaned.substring(2);
        
        if (withoutCountry.length === 11) {
            const ddd = withoutCountry.substring(0, 2);
            const rest = withoutCountry.substring(2);
            
            if (rest.startsWith('9') && rest.length === 9) {
                cleaned = '55' + ddd + rest.substring(1);
            }
        }
        else if (withoutCountry.length === 12) {
            const possibleDDD = withoutCountry.substring(0, 3);
            if (possibleDDD.endsWith('9')) {
                const realDDD = possibleDDD.substring(0, 2);
                const rest = withoutCountry.substring(3);
                cleaned = '55' + realDDD + rest;
            }
        }
    }
    
    console.log(`📱 Normalização: ${phone} → ${cleaned}`);
    return cleaned;
}

// Verificar equivalência de números
function phoneNumbersMatch(phone1, phone2) {
    const norm1 = normalizePhoneNumber(phone1);
    const norm2 = normalizePhoneNumber(phone2);
    console.log(`📞 Comparando: ${norm1} === ${norm2} ? ${norm1 === norm2}`);
    return norm1 === norm2;
}

// Encontrar estado de conversa
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
        console.log('========================================');
        console.log('EVOLUTION WEBHOOK RECEBIDO:', getBrazilTime());
        console.log('PAYLOAD COMPLETO:', JSON.stringify(req.body, null, 2));
        console.log('========================================');
        
        const data = req.body;
        
        addLog('evolution_raw', `Payload Evolution recebido`, { 
            raw_body: req.body,
            headers: req.headers 
        });
        
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            console.log('⚠️ Estrutura não esperada - messageData ou key ausente');
            addLog('warning', `Evolution: estrutura inesperada`, { body: req.body });
            return res.status(200).json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || '';
        
        const apiKey = data.apikey;
        const instanceName = data.instance;
        
        console.log('📱 Remote JID:', remoteJid);
        console.log('👤 From Me:', fromMe, '(tipo:', typeof fromMe, ')');
        console.log('💬 Message Content:', messageContent);
        console.log('🏷️ Instance Name:', instanceName);
        console.log('🔑 API Key:', apiKey);
        
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        const knownInstance = INSTANCES.find(i => i.id === apiKey || i.name === instanceName);
        const finalInstanceName = knownInstance ? knownInstance.name : instanceName || 'UNKNOWN';
        
        addLog('evolution_webhook', `Evolution: ${clientNumber} | FromMe: ${fromMe} | Instância: ${finalInstanceName}`);
        
        console.log('🔍 Verificando conversationState para:', clientNumber);
        console.log('📊 Total de conversas ativas:', conversationState.size);
        
        if (conversationState.size > 0) {
            console.log('📋 Números com conversa ativa:');
            for (const [phone, state] of conversationState.entries()) {
                console.log(`  - ${phone}: ${state.product} | ${state.original_event} | Criado: ${state.createdAt}`);
            }
        }
        
        const conversationMatch = findConversationState(clientNumber);
        
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
                vcard_sent: false,
                createdAt: new Date()
            });
            addLog('info', `🧪 Estado de teste criado para ${clientNumber}`);
        }
        
        const finalMatch = conversationMatch || findConversationState(clientNumber);
        
        if (!finalMatch) {
            console.log(`❌ Cliente ${clientNumber} NÃO está no conversationState`);
            console.log(`   Tentou normalizado: ${normalizePhoneNumber(clientNumber)}`);
            addLog('info', `❓ Cliente ${clientNumber} não encontrado no estado de conversa - mensagem ignorada`);
            return res.status(200).json({ success: true, message: 'Cliente não encontrado' });
        }
        
        const { phone: matchedPhone, state: clientState } = finalMatch;
        console.log(`✅ Estado encontrado para ${matchedPhone}:`, JSON.stringify(clientState, null, 2));
        
        if (fromMe) {
            clientState.last_system_message = new Date();
            clientState.waiting_for_response = true;
            
            if (FEATURES.VCARD_ENABLED && !clientState.vcard_sent) {
                clientState.vcard_sent = true;
                addLog('info', `📇 vCard marcado para envio para ${clientNumber}`);
            }
            
            updateInstanceMetrics(finalInstanceName, 'message_sent', 1);
            
            addLog('info', `📤 Sistema enviou mensagem para ${clientNumber} via ${finalInstanceName}`);
            
            addEventToHistory('mensagem_enviada', 'success', {
                clientName: clientState.client_name || 'Cliente',
                clientPhone: clientNumber,
                orderCode: clientState.order_code,
                product: clientState.product,
                instance: finalInstanceName,
                responseContent: messageContent.substring(0, 100)
            });
            
        } else {
            console.log('📨 Mensagem do cliente detectada');
            console.log('⏳ Waiting for response:', clientState.waiting_for_response);
            console.log('🔢 Response count:', clientState.response_count);
            
            if (clientState.response_count === 0) {
                clientState.response_count = 1;
                clientState.waiting_for_response = false;
                
                updateInstanceMetrics(finalInstanceName, 'response_received', 1);
                
                addLog('info', `📥 PRIMEIRA RESPOSTA do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
                console.log('🚀 ENVIANDO RESPOSTA_01 PARA N8N');
                
                const fullName = clientState.client_name || messageData.pushName || 'Cliente';
                const firstName = fullName.split(' ')[0];
                
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
                
                const sendResult = await sendToN8N(eventData, 'resposta_01');
                console.log('📤 Resultado do envio para N8N:', sendResult);
                
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

// Enviar dados para N8N
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

// ========== ROTAS DA API ==========

// Status principal com métricas expandidas
app.get('/status', async (req, res) => {
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
        vcard_sent: state.vcard_sent,
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
    
    // Prepara métricas por instância com status
    const instanceStats = [];
    const instanceStatuses = await checkAllInstancesStatus();
    
    for (const instance of INSTANCES) {
        const metrics = instanceMetrics.get(instance.name) || {
            messagesSent: 0,
            responsesReceived: 0,
            conversions: 0,
            pixGenerated: 0,
            pixTimeout: 0,
            totalRevenue: 0,
            dailyStats: { leads: 0, sales: 0, date: getBrazilDate() }
        };
        
        const activeCount = conversationList.filter(c => c.instance === instance.name).length;
        const status = instanceStatuses[instance.name] || { online: false };
        
        instanceStats.push({
            instance: instance.name,
            displayName: instance.displayName,
            online: status.online,
            state: status.state || 'unknown',
            ...metrics,
            activeConversations: activeCount,
            conversionRate: metrics.pixGenerated > 0 
                ? ((metrics.conversions / metrics.pixGenerated) * 100).toFixed(2) + '%'
                : '0%',
            responseRate: metrics.messagesSent > 0
                ? ((metrics.responsesReceived / metrics.messagesSent) * 100).toFixed(2) + '%'
                : '0%'
        });
    }
    
    // Buscar métricas do Facebook
    const facebookMetrics = await fetchFacebookMetrics();
    
    const recentLogs = systemLogs.slice(-100);
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        uptime: process.uptime(),
        features_enabled: FEATURES,
        facebook_capi_configured: !!FACEBOOK_CONFIG.ACCESS_TOKEN,
        google_oauth_configured: !!GOOGLE_CONFIG.CLIENT_ID,
        pending_pix_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        client_instance_mappings: clientInstanceMap.size,
        orders: pendingList,
        conversations: conversationList,
        delivery_reports: reportStats,
        system_stats: systemStats,
        instance_metrics: instanceStats,
        facebook_metrics: facebookMetrics,
        logs_last_hour: recentLogs,
        evolution_api_url: EVOLUTION_API_URL,
        n8n_webhook_url: N8N_WEBHOOK_URL,
        data_retention: '24 hours',
        pix_timeout: '7 minutes'
    });
});

// Eventos
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

// Estatísticas expandidas
app.get('/stats', async (req, res) => {
    const uptime = process.uptime();
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);
    
    let totalRevenue = 0;
    let totalConversions = 0;
    let totalPixGenerated = 0;
    
    for (const [name, metrics] of instanceMetrics.entries()) {
        totalRevenue += metrics.totalRevenue || 0;
        totalConversions += metrics.conversions || 0;
        totalPixGenerated += metrics.pixGenerated || 0;
    }
    
    const facebookMetrics = await fetchFacebookMetrics();
    const roi = facebookMetrics && facebookMetrics.totals.total_spend > 0
        ? ((totalRevenue - facebookMetrics.totals.total_spend) / facebookMetrics.totals.total_spend * 100).toFixed(2)
        : 'N/A';
    
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
        revenue: {
            total: `R$ ${totalRevenue.toFixed(2)}`,
            conversions: totalConversions,
            pixGenerated: totalPixGenerated,
            conversionRate: totalPixGenerated > 0
                ? ((totalConversions / totalPixGenerated) * 100).toFixed(2) + '%'
                : '0%'
        },
        facebook: facebookMetrics ? {
            spend: `R$ ${facebookMetrics.totals.total_spend.toFixed(2)}`,
            clicks: facebookMetrics.totals.total_clicks,
            impressions: facebookMetrics.totals.total_impressions,
            cpc: `R$ ${facebookMetrics.totals.avg_cpc.toFixed(2)}`,
            ctr: `${facebookMetrics.totals.avg_ctr.toFixed(2)}%`,
            roi: `${roi}%`
        } : null,
        features: FEATURES,
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Métricas do Facebook
app.get('/api/facebook/metrics', async (req, res) => {
    try {
        const metrics = await fetchFacebookMetrics();
        res.json(metrics || { error: 'Métricas não disponíveis' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Status das instâncias
app.get('/api/instances/status', async (req, res) => {
    try {
        const statuses = await checkAllInstancesStatus();
        res.json(statuses);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Google OAuth2 (Preparado)
app.get('/auth/google', (req, res) => {
    const authUrl = generateGoogleAuthUrl();
    if (!authUrl) {
        return res.status(500).send('Google OAuth não configurado. Configure CLIENT_ID e CLIENT_SECRET.');
    }
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    
    if (!code) {
        return res.status(400).send('Código não fornecido');
    }
    
    const tokens = await exchangeCodeForTokens(code);
    
    if (!tokens) {
        return res.status(500).send('Erro ao obter tokens');
    }
    
    // Salvar tokens em memória (em produção, salvar em banco de dados)
    global.googleTokens = tokens;
    
    res.send(`
        <html>
            <body style="font-family: Arial; text-align: center; padding: 50px;">
                <h2>✅ Google Contacts autorizado com sucesso!</h2>
                <p>Os contatos serão sincronizados automaticamente.</p>
                <script>setTimeout(() => window.close(), 3000);</script>
            </body>
        </html>
    `);
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
        features: FEATURES,
        config: {
            n8n_webhook_url: N8N_WEBHOOK_URL,
            data_retention: '24 hours',
            pix_timeout: '7 minutes',
            facebook_configured: !!FACEBOOK_CONFIG.ACCESS_TOKEN,
            google_configured: !!GOOGLE_CONFIG.CLIENT_ID
        }
    });
});

// Dashboard HTML
app.get('/', (req, res) => {
    res.send(getHTMLContent());
});

// Função para gerar HTML do Dashboard
function getHTMLContent() {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <title>Cérebro de Atendimento PRO</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --primary: #6366f1;
            --primary-dark: #4f46e5;
            --secondary: #8b5cf6;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
            --info: #3b82f6;
            --dark: #1f2937;
            --gray: #6b7280;
            --light: #f9fafb;
            --white: #ffffff;
            --facebook: #1877f2;
            --google: #4285f4;
            --whatsapp: #25d366;
        }
        
        body { 
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { 
            max-width: 1800px; 
            margin: 0 auto; 
        }
        
        .header {
            background: rgba(255, 255, 255, 0.98);
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        h1 { 
            color: var(--dark); 
            font-size: 2.5rem; 
            font-weight: 800; 
            margin-bottom: 10px;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .subtitle {
            color: var(--gray);
            font-size: 1.1rem;
            margin-bottom: 20px;
        }
        
        .feature-badges {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-bottom: 20px;
        }
        
        .feature-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 0.85rem;
            font-weight: 600;
            color: white;
        }
        
        .feature-badge.active { background: var(--success); }
        .feature-badge.inactive { background: var(--gray); opacity: 0.6; }
        .feature-badge.facebook { background: var(--facebook); }
        .feature-badge.google { background: var(--google); }
        .feature-badge.whatsapp { background: var(--whatsapp); }
        
        .config-info {
            background: var(--light);
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 20px;
        }
        
        .config-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 15px;
        }
        
        .config-item {
            display: flex;
            justify-content: space-between;
            padding: 10px;
            background: white;
            border-radius: 8px;
            border-left: 3px solid var(--primary);
        }
        
        .config-label {
            color: var(--gray);
            font-weight: 600;
            font-size: 0.9rem;
        }
        
        .config-value {
            color: var(--dark);
            font-weight: 500;
            font-size: 0.9rem;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card { 
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.08);
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        
        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 4px;
            height: 100%;
            background: var(--primary);
        }
        
        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 35px rgba(0,0,0,0.12);
        }
        
        .stat-card.success::before { background: var(--success); }
        .stat-card.warning::before { background: var(--warning); }
        .stat-card.info::before { background: var(--info); }
        .stat-card.danger::before { background: var(--danger); }
        .stat-card.facebook::before { background: var(--facebook); }
        
        .stat-icon {
            position: absolute;
            top: 20px;
            right: 20px;
            font-size: 2rem;
            opacity: 0.1;
        }
        
        .stat-label {
            font-size: 0.9rem;
            color: var(--gray);
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 600;
        }
        
        .stat-value {
            font-size: 2.2rem;
            font-weight: 800;
            color: var(--dark);
            line-height: 1;
        }
        
        .stat-change {
            font-size: 0.85rem;
            color: var(--gray);
            margin-top: 8px;
        }
        
        .controls {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            margin-bottom: 30px;
        }
        
        .btn { 
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            color: white; 
            border: none; 
            padding: 12px 25px; 
            border-radius: 25px; 
            cursor: pointer; 
            font-weight: 600;
            font-size: 0.95rem;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn:hover { 
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }
        
        .btn-secondary { background: var(--gray); }
        .btn-success { background: var(--success); }
        .btn-facebook { background: var(--facebook); }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid var(--light);
            overflow-x: auto;
        }
        
        .tab {
            padding: 12px 24px;
            background: none;
            border: none;
            color: var(--gray);
            font-weight: 600;
            cursor: pointer;
            position: relative;
            transition: color 0.3s ease;
            white-space: nowrap;
        }
        
        .tab.active {
            color: var(--primary);
        }
        
        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: var(--primary);
        }
        
        .content-panel {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            min-height: 500px;
        }
        
        .chart-container {
            position: relative;
            height: 400px;
            margin: 20px 0;
        }
        
        .instance-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }
        
        .instance-card {
            background: white;
            border-radius: 15px;
            padding: 20px;
            border: 2px solid var(--light);
            transition: all 0.3s ease;
        }
        
        .instance-card:hover {
            border-color: var(--primary);
            transform: translateY(-2px);
        }
        
        .instance-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        
        .instance-name {
            font-size: 1.2rem;
            font-weight: 700;
            color: var(--dark);
        }
        
        .instance-status {
            display: flex;
            align-items: center;
            gap: 5px;
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 600;
        }
        
        .instance-status.online {
            background: #d1fae5;
            color: #065f46;
        }
        
        .instance-status.offline {
            background: #fee2e2;
            color: #991b1b;
        }
        
        .instance-metrics {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        
        .metric-item {
            padding: 8px;
            background: var(--light);
            border-radius: 8px;
        }
        
        .metric-label {
            font-size: 0.75rem;
            color: var(--gray);
            text-transform: uppercase;
            margin-bottom: 2px;
        }
        
        .metric-value {
            font-size: 1.2rem;
            font-weight: 700;
            color: var(--dark);
        }
        
        .facebook-metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        
        .fb-metric-card {
            background: linear-gradient(135deg, #e0e7ff, #c7d2fe);
            padding: 15px;
            border-radius: 12px;
            text-align: center;
        }
        
        .fb-metric-label {
            font-size: 0.85rem;
            color: var(--gray);
            margin-bottom: 5px;
        }
        
        .fb-metric-value {
            font-size: 1.5rem;
            font-weight: 700;
            color: var(--primary-dark);
        }
        
        .table-container {
            overflow-x: auto;
            margin-top: 20px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th {
            background: var(--light);
            padding: 12px;
            text-align: left;
            font-weight: 600;
            color: var(--dark);
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        td {
            padding: 12px;
            border-bottom: 1px solid var(--light);
            font-size: 0.95rem;
            color: var(--dark);
        }
        
        tr:hover {
            background: #f8f9fa;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .badge-success { background: #d1fae5; color: #065f46; }
        .badge-warning { background: #fed7cc; color: #9a3412; }
        .badge-danger { background: #fee2e2; color: #991b1b; }
        .badge-info { background: #dbeafe; color: #1e40af; }
        .badge-facebook { background: #dbeafe; color: #1e40af; }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--gray);
        }
        
        .empty-state i {
            font-size: 4rem;
            margin-bottom: 20px;
            opacity: 0.3;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: var(--gray);
        }
        
        .spinner {
            border: 3px solid var(--light);
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .filters {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        
        .filter-group {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        
        .filter-label {
            font-size: 0.85rem;
            color: var(--gray);
            font-weight: 600;
        }
        
        .filter-input, .filter-select {
            padding: 8px 15px;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            font-size: 0.95rem;
        }
        
        @media (max-width: 768px) {
            body { padding: 10px; }
            h1 { font-size: 1.8rem; }
            .stats-grid { grid-template-columns: 1fr; }
            .instance-grid { grid-template-columns: 1fr; }
            .tabs { overflow-x: auto; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-brain"></i> Cérebro de Atendimento PRO</h1>
            <div class="subtitle">Sistema Inteligente de Gestão com Facebook Marketing API & Google Contacts</div>
            
            <div class="feature-badges" id="feature-badges">
                <!-- Badges serão inseridos dinamicamente -->
            </div>
            
            <div class="config-info">
                <div class="config-grid">
                    <div class="config-item">
                        <span class="config-label">N8N Webhook</span>
                        <span class="config-value" id="n8n-url">Carregando...</span>
                    </div>
                    <div class="config-item">
                        <span class="config-label">Retenção de Dados</span>
                        <span class="config-value">24 horas</span>
                    </div>
                    <div class="config-item">
                        <span class="config-label">Timeout PIX</span>
                        <span class="config-value">7 minutos</span>
                    </div>
                    <div class="config-item">
                        <span class="config-label">Localização por DDD</span>
                        <span class="config-value">✅ Ativa</span>
                    </div>
                    <div class="config-item">
                        <span class="config-label">Facebook Pixel</span>
                        <span class="config-value">1041071206927840</span>
                    </div>
                    <div class="config-item">
                        <span class="config-label">Horário</span>
                        <span class="config-value" id="current-time">--</span>
                    </div>
                </div>
            </div>
            
            <div class="stats-grid" id="main-stats">
                <!-- Cards de estatísticas serão inseridos dinamicamente -->
            </div>
            
            <div class="controls">
                <button class="btn" onclick="refreshData()">
                    <i class="fas fa-sync-alt"></i> Atualizar Dados
                </button>
                <button class="btn btn-facebook" onclick="syncFacebook()">
                    <i class="fab fa-facebook"></i> Sync Facebook
                </button>
                <button class="btn btn-secondary" onclick="exportData()">
                    <i class="fas fa-download"></i> Exportar Relatório
                </button>
                <button class="btn btn-success" onclick="authorizeGoogle()">
                    <i class="fab fa-google"></i> Autorizar Google
                </button>
            </div>
        </div>
        
        <div class="content-panel">
            <div class="tabs">
                <button class="tab active" onclick="switchTab(event, 'dashboard')">
                    <i class="fas fa-chart-line"></i> Dashboard
                </button>
                <button class="tab" onclick="switchTab(event, 'instances')">
                    <i class="fas fa-server"></i> Instâncias
                </button>
                <button class="tab" onclick="switchTab(event, 'facebook')">
                    <i class="fab fa-facebook"></i> Facebook Ads
                </button>
                <button class="tab" onclick="switchTab(event, 'events')">
                    <i class="fas fa-list"></i> Eventos
                </button>
                <button class="tab" onclick="switchTab(event, 'conversations')">
                    <i class="fas fa-comments"></i> Conversas
                </button>
                <button class="tab" onclick="switchTab(event, 'pending')">
                    <i class="fas fa-hourglass-half"></i> PIX Pendentes
                </button>
            </div>
            
            <div id="tab-content">
                <!-- Conteúdo dinâmico será inserido aqui -->
            </div>
        </div>
    </div>
    
    <script>
        let currentTab = 'dashboard';
        let currentData = {
            status: null,
            events: [],
            stats: null
        };
        let charts = {};
        
        // Atualiza relógio
        function updateClock() {
            const now = new Date();
            const brazilTime = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            document.getElementById('current-time').textContent = brazilTime;
        }
        setInterval(updateClock, 1000);
        updateClock();
        
        // Alternar abas
        function switchTab(event, tab) {
            currentTab = tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            loadTabContent();
        }
        
        // Carregar conteúdo da aba
        function loadTabContent() {
            const content = document.getElementById('tab-content');
            content.innerHTML = '<div class="loading"><div class="spinner"></div>Carregando...</div>';
            
            switch(currentTab) {
                case 'dashboard':
                    loadDashboardTab();
                    break;
                case 'instances':
                    loadInstancesTab();
                    break;
                case 'facebook':
                    loadFacebookTab();
                    break;
                case 'events':
                    loadEventsTab();
                    break;
                case 'conversations':
                    loadConversationsTab();
                    break;
                case 'pending':
                    loadPendingTab();
                    break;
            }
        }
        
        // Dashboard com gráficos
        async function loadDashboardTab() {
            const content = document.getElementById('tab-content');
            
            let html = '<h3 style="margin-bottom: 20px;">Visão Geral do Sistema</h3>';
            
            // Gráficos
            html += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">';
            html += '<div class="chart-container"><canvas id="conversionChart"></canvas></div>';
            html += '<div class="chart-container"><canvas id="revenueChart"></canvas></div>';
            html += '</div>';
            
            // Métricas rápidas
            html += '<div class="facebook-metrics" id="quick-metrics"></div>';
            
            content.innerHTML = html;
            
            // Criar gráficos
            setTimeout(() => {
                createConversionChart();
                createRevenueChart();
                loadQuickMetrics();
            }, 100);
        }
        
        // Gráfico de conversão
        function createConversionChart() {
            const ctx = document.getElementById('conversionChart');
            if (!ctx) return;
            
            if (charts.conversion) charts.conversion.destroy();
            
            const instanceData = currentData.status?.instance_metrics || [];
            
            charts.conversion = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: instanceData.map(i => i.displayName || i.instance),
                    datasets: [{
                        label: 'Conversões',
                        data: instanceData.map(i => i.conversions || 0),
                        backgroundColor: 'rgba(16, 185, 129, 0.6)',
                        borderColor: 'rgba(16, 185, 129, 1)',
                        borderWidth: 2
                    }, {
                        label: 'PIX Gerados',
                        data: instanceData.map(i => i.pixGenerated || 0),
                        backgroundColor: 'rgba(245, 158, 11, 0.6)',
                        borderColor: 'rgba(245, 158, 11, 1)',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Conversões por Instância'
                        }
                    }
                }
            });
        }
        
        // Gráfico de receita
        function createRevenueChart() {
            const ctx = document.getElementById('revenueChart');
            if (!ctx) return;
            
            if (charts.revenue) charts.revenue.destroy();
            
            const fbData = currentData.status?.facebook_metrics;
            if (!fbData) return;
            
            charts.revenue = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Receita', 'Gastos com Ads'],
                    datasets: [{
                        data: [
                            fbData.totals?.total_conversion_value || 0,
                            fbData.totals?.total_spend || 0
                        ],
                        backgroundColor: [
                            'rgba(16, 185, 129, 0.8)',
                            'rgba(239, 68, 68, 0.8)'
                        ]
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: 'ROI - Receita vs Gastos'
                        }
                    }
                }
            });
        }
        
        // Métricas rápidas
        function loadQuickMetrics() {
            const container = document.getElementById('quick-metrics');
            if (!container) return;
            
            const fbData = currentData.status?.facebook_metrics;
            if (!fbData) {
                container.innerHTML = '<p>Métricas do Facebook não disponíveis</p>';
                return;
            }
            
            let html = '';
            const metrics = [
                { label: 'Gastos Hoje', value: 'R$ ' + (fbData.totals?.total_spend || 0).toFixed(2), icon: '💰' },
                { label: 'Cliques', value: fbData.totals?.total_clicks || 0, icon: '👆' },
                { label: 'CPC Médio', value: 'R$ ' + (fbData.totals?.avg_cpc || 0).toFixed(2), icon: '💵' },
                { label: 'CTR', value: (fbData.totals?.avg_ctr || 0).toFixed(2) + '%', icon: '📊' },
                { label: 'Impressões', value: fbData.totals?.total_impressions || 0, icon: '👁️' },
                { label: 'ROAS', value: (fbData.totals?.overall_roas || 0).toFixed(2) + 'x', icon: '📈' }
            ];
            
            metrics.forEach(m => {
                html += `<div class="fb-metric-card">
                    <div style="font-size: 2rem; margin-bottom: 5px;">${m.icon}</div>
                    <div class="fb-metric-label">${m.label}</div>
                    <div class="fb-metric-value">${m.value}</div>
                </div>`;
            });
            
            container.innerHTML = html;
        }
        
        // Instâncias
        async function loadInstancesTab() {
            const content = document.getElementById('tab-content');
            
            if (!currentData.status || !currentData.status.instance_metrics) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-server"></i><h3>Nenhuma instância disponível</h3></div>';
                return;
            }
            
            let html = '<h3 style="margin-bottom: 20px;">Status das Instâncias WhatsApp</h3>';
            html += '<div class="instance-grid">';
            
            currentData.status.instance_metrics.forEach(instance => {
                const statusClass = instance.online ? 'online' : 'offline';
                const statusText = instance.online ? 'Online' : 'Offline';
                const statusIcon = instance.online ? '🟢' : '🔴';
                
                html += '<div class="instance-card">';
                html += '<div class="instance-header">';
                html += '<div class="instance-name">' + (instance.displayName || instance.instance) + '</div>';
                html += '<div class="instance-status ' + statusClass + '">' + statusIcon + ' ' + statusText + '</div>';
                html += '</div>';
                
                html += '<div class="instance-metrics">';
                html += '<div class="metric-item"><div class="metric-label">Leads Hoje</div><div class="metric-value">' + (instance.dailyStats?.leads || 0) + '</div></div>';
                html += '<div class="metric-item"><div class="metric-label">Vendas Hoje</div><div class="metric-value">' + (instance.dailyStats?.sales || 0) + '</div></div>';
                html += '<div class="metric-item"><div class="metric-label">Conversas</div><div class="metric-value">' + (instance.activeConversations || 0) + '</div></div>';
                html += '<div class="metric-item"><div class="metric-label">Taxa Conv.</div><div class="metric-value">' + instance.conversionRate + '</div></div>';
                html += '<div class="metric-item"><div class="metric-label">Msgs Enviadas</div><div class="metric-value">' + (instance.messagesSent || 0) + '</div></div>';
                html += '<div class="metric-item"><div class="metric-label">Respostas</div><div class="metric-value">' + (instance.responsesReceived || 0) + '</div></div>';
                html += '<div class="metric-item"><div class="metric-label">Receita</div><div class="metric-value">R$ ' + (instance.totalRevenue || 0).toFixed(2) + '</div></div>';
                html += '<div class="metric-item"><div class="metric-label">PIX Timeout</div><div class="metric-value">' + (instance.pixTimeout || 0) + '</div></div>';
                html += '</div>';
                html += '</div>';
            });
            
            html += '</div>';
            content.innerHTML = html;
        }
        
        // Facebook Ads
        async function loadFacebookTab() {
            const content = document.getElementById('tab-content');
            const fbData = currentData.status?.facebook_metrics;
            
            if (!fbData) {
                content.innerHTML = '<div class="empty-state"><i class="fab fa-facebook"></i><h3>Métricas do Facebook não disponíveis</h3><p>Configure o Facebook Marketing API</p></div>';
                return;
            }
            
            let html = '<h3 style="margin-bottom: 20px;">Métricas do Facebook Ads</h3>';
            
            // Totais
            html += '<div class="facebook-metrics">';
            html += '<div class="fb-metric-card"><div class="fb-metric-label">Gastos Total</div><div class="fb-metric-value">R$ ' + fbData.totals.total_spend.toFixed(2) + '</div></div>';
            html += '<div class="fb-metric-card"><div class="fb-metric-label">Cliques</div><div class="fb-metric-value">' + fbData.totals.total_clicks + '</div></div>';
            html += '<div class="fb-metric-card"><div class="fb-metric-label">Impressões</div><div class="fb-metric-value">' + fbData.totals.total_impressions + '</div></div>';
            html += '<div class="fb-metric-card"><div class="fb-metric-label">CPC Médio</div><div class="fb-metric-value">R$ ' + fbData.totals.avg_cpc.toFixed(2) + '</div></div>';
            html += '<div class="fb-metric-card"><div class="fb-metric-label">CPM Médio</div><div class="fb-metric-value">R$ ' + fbData.totals.avg_cpm.toFixed(2) + '</div></div>';
            html += '<div class="fb-metric-card"><div class="fb-metric-label">CTR</div><div class="fb-metric-value">' + fbData.totals.avg_ctr.toFixed(2) + '%</div></div>';
            html += '</div>';
            
            // Por conta
            html += '<h4 style="margin: 30px 0 20px;">Detalhamento por Conta</h4>';
            html += '<div class="table-container"><table><thead><tr>';
            html += '<th>Conta</th><th>Gastos</th><th>Cliques</th><th>CPC</th><th>CTR</th><th>Conversões</th><th>ROAS</th>';
            html += '</tr></thead><tbody>';
            
            fbData.metrics_by_account.forEach(account => {
                html += '<tr>';
                html += '<td><strong>' + account.account_name + '</strong></td>';
                html += '<td>R$ ' + account.spend.toFixed(2) + '</td>';
                html += '<td>' + account.clicks + '</td>';
                html += '<td>R$ ' + account.cpc.toFixed(2) + '</td>';
                html += '<td>' + account.ctr.toFixed(2) + '%</td>';
                html += '<td>' + account.conversions + '</td>';
                html += '<td>' + (account.roas || 0).toFixed(2) + 'x</td>';
                html += '</tr>';
            });
            
            html += '</tbody></table></div>';
            content.innerHTML = html;
        }
        
        // Eventos
        async function loadEventsTab() {
            try {
                const response = await fetch('/events?limit=100');
                const data = await response.json();
                
                const content = document.getElementById('tab-content');
                
                if (data.events.length === 0) {
                    content.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><h3>Nenhum evento nas últimas 24h</h3></div>';
                    return;
                }
                
                let html = '<h3 style="margin-bottom: 20px;">Eventos do Sistema</h3>';
                html += '<div class="filters">';
                html += '<div class="filter-group"><label class="filter-label">Tipo</label>';
                html += '<select class="filter-select" id="filter-type" onchange="filterEvents()">';
                html += '<option value="">Todos</option>';
                html += '<option value="pix_gerado">PIX Gerado</option>';
                html += '<option value="venda_aprovada">Venda Aprovada</option>';
                html += '<option value="pix_timeout">PIX Timeout</option>';
                html += '<option value="resposta_cliente">Resposta Cliente</option>';
                html += '</select></div>';
                html += '</div>';
                
                html += '<div class="table-container"><table><thead><tr>';
                html += '<th>Data/Hora</th><th>Tipo</th><th>Status</th><th>Cliente</th><th>Produto</th><th>Instância</th>';
                html += '</tr></thead><tbody id="events-tbody">';
                
                data.events.forEach(event => {
                    html += '<tr>';
                    html += '<td>' + event.date + ' ' + event.time + '</td>';
                    html += '<td><span class="badge badge-info">' + formatEventType(event.type) + '</span></td>';
                    html += '<td><span class="badge badge-' + (event.status === 'success' ? 'success' : 'danger') + '">' + event.status + '</span></td>';
                    html += '<td>' + event.clientName + '</td>';
                    html += '<td><span class="badge badge-warning">' + event.product + '</span></td>';
                    html += '<td>' + event.instance + '</td>';
                    html += '</tr>';
                });
                
                html += '</tbody></table></div>';
                content.innerHTML = html;
                currentData.events = data.events;
            } catch (error) {
                console.error('Erro ao carregar eventos:', error);
            }
        }
        
        // Conversas
        async function loadConversationsTab() {
            const content = document.getElementById('tab-content');
            
            if (!currentData.status || currentData.status.conversations.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><h3>Nenhuma conversa ativa</h3></div>';
                return;
            }
            
            let html = '<h3 style="margin-bottom: 20px;">Conversas Ativas</h3>';
            html += '<div class="table-container"><table><thead><tr>';
            html += '<th>Cliente</th><th>Telefone</th><th>Produto</th><th>Instância</th><th>Status</th><th>Respostas</th>';
            html += '</tr></thead><tbody>';
            
            currentData.status.conversations.forEach(conv => {
                html += '<tr>';
                html += '<td>' + (conv.client_name || 'Cliente') + '</td>';
                html += '<td>' + conv.phone + '</td>';
                html += '<td><span class="badge badge-info">' + conv.product + '</span></td>';
                html += '<td>' + conv.instance + '</td>';
                html += '<td><span class="badge badge-' + (conv.waiting_for_response ? 'warning' : 'success') + '">';
                html += (conv.waiting_for_response ? 'Aguardando' : 'Respondido') + '</span></td>';
                html += '<td>' + conv.response_count + '</td>';
                html += '</tr>';
            });
            
            html += '</tbody></table></div>';
            content.innerHTML = html;
        }
        
        // PIX Pendentes
        async function loadPendingTab() {
            const content = document.getElementById('tab-content');
            
            if (!currentData.status || currentData.status.orders.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-clock"></i><h3>Nenhum PIX pendente</h3></div>';
                return;
            }
            
            let html = '<h3 style="margin-bottom: 20px;">PIX Pendentes</h3>';
            html += '<div class="table-container"><table><thead><tr>';
            html += '<th>Código</th><th>Cliente</th><th>Produto</th><th>Valor</th><th>Tempo Restante</th>';
            html += '</tr></thead><tbody>';
            
            currentData.status.orders.forEach(order => {
                const minutes = Math.floor(order.remaining_time / 1000 / 60);
                const seconds = Math.floor((order.remaining_time / 1000) % 60);
                html += '<tr>';
                html += '<td>' + order.code + '</td>';
                html += '<td>' + order.full_name + '</td>';
                html += '<td><span class="badge badge-warning">' + order.product + '</span></td>';
                html += '<td>R$ ' + order.amount.toFixed(2) + '</td>';
                html += '<td><span class="badge badge-' + (minutes < 2 ? 'danger' : 'warning') + '">';
                html += minutes + ':' + seconds.toString().padStart(2, '0') + '</span></td>';
                html += '</tr>';
            });
            
            html += '</tbody></table></div>';
            content.innerHTML = html;
        }
        
        // Funções auxiliares
        function formatEventType(type) {
            const types = {
                'pix_gerado': 'PIX Gerado',
                'venda_aprovada': 'Venda Aprovada',
                'pix_timeout': 'PIX Timeout',
                'resposta_cliente': 'Resposta',
                'mensagem_enviada': 'Msg Enviada'
            };
            return types[type] || type;
        }
        
        function filterEvents() {
            const type = document.getElementById('filter-type')?.value;
            if (!type) return;
            
            const filtered = type ? currentData.events.filter(e => e.type === type) : currentData.events;
            const tbody = document.getElementById('events-tbody');
            
            let html = '';
            filtered.forEach(event => {
                html += '<tr>';
                html += '<td>' + event.date + ' ' + event.time + '</td>';
                html += '<td><span class="badge badge-info">' + formatEventType(event.type) + '</span></td>';
                html += '<td><span class="badge badge-' + (event.status === 'success' ? 'success' : 'danger') + '">' + event.status + '</span></td>';
                html += '<td>' + event.clientName + '</td>';
                html += '<td><span class="badge badge-warning">' + event.product + '</span></td>';
                html += '<td>' + event.instance + '</td>';
                html += '</tr>';
            });
            tbody.innerHTML = html;
        }
        
        // Atualizar badges
        function updateFeatureBadges() {
            const container = document.getElementById('feature-badges');
            if (!container || !currentData.status) return;
            
            let html = '';
            const features = currentData.status.features_enabled;
            
            if (features) {
                html += '<span class="feature-badge active"><i class="fas fa-map-marker-alt"></i> Localização</span>';
                html += '<span class="feature-badge ' + (features.VCARD_ENABLED ? 'active' : 'inactive') + '"><i class="fas fa-address-card"></i> vCard</span>';
                html += '<span class="feature-badge ' + (features.FACEBOOK_CAPI_ENABLED ? 'facebook' : 'inactive') + '"><i class="fab fa-facebook"></i> Facebook CAPI</span>';
                html += '<span class="feature-badge ' + (features.FACEBOOK_MARKETING_API_ENABLED ? 'facebook' : 'inactive') + '"><i class="fab fa-facebook"></i> Marketing API</span>';
                html += '<span class="feature-badge ' + (features.GOOGLE_CONTACTS_ENABLED ? 'google' : 'inactive') + '"><i class="fab fa-google"></i> Google Contacts</span>';
                html += '<span class="feature-badge whatsapp"><i class="fab fa-whatsapp"></i> ' + currentData.status.instance_metrics.length + ' Instâncias</span>';
            }
            
            container.innerHTML = html;
        }
        
        // Atualizar cards principais
        function updateMainStats() {
            const container = document.getElementById('main-stats');
            if (!container || !currentData.status) return;
            
            const fbData = currentData.status.facebook_metrics;
            const stats = [
                { label: 'PIX Pendentes', value: currentData.status.pending_pix_orders, class: 'warning', icon: 'fa-clock' },
                { label: 'Conversas Ativas', value: currentData.status.active_conversations, class: 'info', icon: 'fa-comments' },
                { label: 'Vendas (24h)', value: currentData.status.delivery_reports.venda_aprovada, class: 'success', icon: 'fa-check-circle' },
                { label: 'Taxa Conversão', value: calculateGlobalConversion() + '%', class: 'info', icon: 'fa-chart-line' },
                { label: 'Gastos Hoje', value: 'R$ ' + (fbData?.totals?.total_spend || 0).toFixed(2), class: 'facebook', icon: 'fab fa-facebook' },
                { label: 'ROI', value: calculateROI(), class: 'success', icon: 'fa-chart-bar' }
            ];
            
            let html = '';
            stats.forEach(stat => {
                html += '<div class="stat-card ' + stat.class + '">';
                html += '<i class="fas ' + stat.icon + ' stat-icon"></i>';
                html += '<div class="stat-label">' + stat.label + '</div>';
                html += '<div class="stat-value">' + stat.value + '</div>';
                html += '</div>';
            });
            
            container.innerHTML = html;
        }
        
        function calculateGlobalConversion() {
            let totalConversions = 0;
            let totalPix = 0;
            
            if (currentData.status?.instance_metrics) {
                currentData.status.instance_metrics.forEach(m => {
                    totalConversions += m.conversions || 0;
                    totalPix += m.pixGenerated || 0;
                });
            }
            
            return totalPix > 0 ? ((totalConversions / totalPix) * 100).toFixed(1) : '0';
        }
        
        function calculateROI() {
            const fbData = currentData.status?.facebook_metrics;
            if (!fbData || !fbData.totals.total_spend) return 'N/A';
            
            let totalRevenue = 0;
            if (currentData.status?.instance_metrics) {
                currentData.status.instance_metrics.forEach(m => {
                    totalRevenue += m.totalRevenue || 0;
                });
            }
            
            const roi = ((totalRevenue - fbData.totals.total_spend) / fbData.totals.total_spend * 100).toFixed(0);
            return roi + '%';
        }
        
        // Atualizar dados
        async function refreshData() {
            try {
                const response = await fetch('/status');
                currentData.status = await response.json();
                
                document.getElementById('n8n-url').textContent = currentData.status.n8n_webhook_url;
                
                updateFeatureBadges();
                updateMainStats();
                loadTabContent();
            } catch (error) {
                console.error('Erro ao atualizar dados:', error);
            }
        }
        
        // Sync Facebook
        async function syncFacebook() {
            try {
                const response = await fetch('/api/facebook/metrics');
                const data = await response.json();
                alert('Facebook sincronizado com sucesso!');
                refreshData();
            } catch (error) {
                alert('Erro ao sincronizar Facebook: ' + error.message);
            }
        }
        
        // Autorizar Google
        function authorizeGoogle() {
            window.open('/auth/google', 'google-auth', 'width=500,height=600');
        }
        
        // Exportar dados
        function exportData() {
            const data = {
                timestamp: new Date().toISOString(),
                brazil_time: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                status: currentData.status,
                events: currentData.events
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'relatorio_cerebro_pro_' + new Date().toISOString().split('T')[0] + '.json';
            a.click();
        }
        
        // Inicialização
        document.addEventListener('DOMContentLoaded', function() {
            refreshData();
            loadTabContent();
            
            // Auto-refresh a cada 15 segundos
            setInterval(refreshData, 15000);
        });
    </script>
</body>
</html>`;
}

// ========== INICIALIZAÇÃO DO SERVIDOR ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🧠 CÉREBRO DE ATENDIMENTO PRO v5.0 iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect: http://localhost:${PORT}/webhook/perfect`);
    addLog('info', `📱 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    addLog('info', `🖥️ Dashboard PRO: http://localhost:${PORT}`);
    addLog('info', `📊 API Facebook: http://localhost:${PORT}/api/facebook/metrics`);
    addLog('info', `🔌 API Instâncias: http://localhost:${PORT}/api/instances/status`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    
    console.log(`\n🧠 CÉREBRO DE ATENDIMENTO PRO v5.0 ATIVO`);
    console.log(`================================================================================`);
    console.log(`✅ FUNCIONALIDADES IMPLEMENTADAS:`);
    console.log(`   📍 Localização por DDD (SEM saudações)`);
    console.log(`   📊 Facebook CAPI + Marketing API`);
    console.log(`   📈 Dashboard Profissional com Gráficos`);
    console.log(`   🔌 Verificação de Status das Instâncias`);
    console.log(`   📇 Google Contacts OAuth2 (Preparado)`);
    console.log(`================================================================================`);
    console.log(`📡 Facebook Pixel: ${FACEBOOK_CONFIG.PIXEL_ID}`);
    console.log(`💼 Contas de Anúncios: ${FACEBOOK_CONFIG.AD_ACCOUNTS.length} configuradas`);
    console.log(`⏰ Horário: ${getBrazilTime()}`);
    console.log(`================================================================================\n`);
    
    // Verificar configurações
    if (!FACEBOOK_CONFIG.ACCESS_TOKEN) {
        console.log('⚠️  ATENÇÃO: Configure FB_ACCESS_TOKEN nas variáveis de ambiente');
    }
    if (!GOOGLE_CONFIG.CLIENT_ID) {
        console.log('⚠️  ATENÇÃO: Configure GOOGLE_CLIENT_ID para ativar Google Contacts');
    }
});
