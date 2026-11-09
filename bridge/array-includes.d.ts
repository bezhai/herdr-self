// Array includes takes any value, as it does in JavaScript: Bridge checks values of wider types, such as a status that may be missing or
// a field of a request, against lists of the values it knows. TypeScript's own signature takes only the type of the elements.
interface Array<T>{includes(searchElement:unknown,fromIndex?:number):boolean}
interface ReadonlyArray<T>{includes(searchElement:unknown,fromIndex?:number):boolean}
