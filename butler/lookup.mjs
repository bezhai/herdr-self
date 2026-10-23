// Finding a sender or a group by what I call it, for the command line and the conversation alike: the items whose id
// (key) or name is exactly the query, else those whose name contains it, ignoring case. More than one is for the
// caller to list, never to pick from.
export function find(items,query,key){
 const exact=items.filter(i=>i[key]===query||i.name===query);if(exact.length)return exact;
 const q=query.toLowerCase();return items.filter(i=>(i.name??'').toLowerCase().includes(q));
}
