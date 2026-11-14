const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
function error(message,status){return new Response(JSON.stringify({error:message}),{status,headers:jsonHeaders})}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/')){
   if(!['GET','HEAD','OPTIONS'].includes(request.method)){
    const origin=request.headers.get('Origin');
    if(origin&&new URL(origin).origin!==url.origin)return error('This request came from another site.',403);
   }
   const base=String(env.SUPABASE_FUNCTION_URL||'').replace(/\/$/,'');
   if(!base||!env.SUPABASE_PUBLISHABLE_KEY)return error('Supabase API connection is not configured.',503);
   const target=`${base}${url.pathname}${url.search}`,headers=new Headers(request.headers);
   headers.delete('Origin');headers.delete('Host');headers.set('apikey',env.SUPABASE_PUBLISHABLE_KEY);
   const init={method:request.method,headers,redirect:'manual'};
   if(!['GET','HEAD'].includes(request.method))init.body=request.body;
   try{
    const upstream=await fetch(target,init),responseHeaders=new Headers(upstream.headers);
    responseHeaders.set('Cache-Control','no-store');
    return new Response(upstream.body,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
   }catch{return error('Could not reach the Supabase API. Check the Worker connection settings.',502)}
  }

  if(!env.ASSETS)return error('Static assets are not configured.',503);
  const pages=new Set(['/','/calendar','/team-calendar','/my-calendar','/find-shifts','/requests','/time-evidence','/team-scorecard','/doctor-management','/user-management','/telegram-alerts','/settings','/help']);
  const assetRequest=pages.has(url.pathname)?new Request(new URL('/',url),request):request;
  const response=await env.ASSETS.fetch(assetRequest),headers=new Headers(response.headers);
  headers.set('Cache-Control','no-store');
  if(response.headers.get('Content-Type')?.includes('text/html'))headers.set('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(response.body,{status:response.status,headers});
 }
};
