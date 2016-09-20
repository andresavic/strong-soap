var xmlBuilder = require('xmlbuilder');
var sax = require('sax');
var stream = require('stream');
var assert = require('assert');
var selectn = require('selectn');
var debug = require('debug')('node-soap:wsdl:xml');
var descriptor = require('./xsd/descriptor');
var ElementDescriptor = descriptor.ElementDescriptor;
var AttributeDescriptor = descriptor.AttributeDescriptor;
var TypeDescriptor = descriptor.TypeDescriptor;
var QName = require('./qname');
var helper = require('./helper');
var NamespaceContext = require('./nscontext');
var Set = helper.Set;


class XMLHandler {
  constructor(options) {
    this.options = options || {};
    this.options.valueKey = this.options.valueKey || '$value';
    this.options.xmlKey = this.options.xmlKey || '$xml';
    this.options.attributesKey = this.options.attributesKey || '$attributes';
    this.options.xsiTypeKey = this.options.xsiTypeKey || '$xsiType';
  }

  jsonToXml(node, nsContext, descriptor, val) {
    if (node == null) {
      node = xmlBuilder.begin(
        {version: '1.0', encoding: 'UTF-8', standalone: true});
    }
    if (nsContext == null) {
      nsContext = new NamespaceContext();
    }

    var name;
    let nameSpaceContextCreated = false;
    if (descriptor instanceof AttributeDescriptor) {
      name = descriptor.qname.name;
      if (descriptor.form === 'unqualified') {
        node.attribute(name, val);
      } else if (descriptor.qname) {
        let mapping = declareNamespace(nsContext, node, descriptor.qname.prefix,
          descriptor.qname.nsURI);
        let prefix = mapping ? mapping.prefix : descriptor.qname.prefix;
        let attrName = prefix ? prefix + ':' + name : name;
        node.attribute(attrName, val);
      }
      return node;
    }

    if (descriptor instanceof ElementDescriptor) {
      name = descriptor.qname.name;
      let isSimple = descriptor.isSimple;
      let attrs = null;
      if (descriptor.isMany) {
        if (Array.isArray(val)) {
          for (let i = 0, n = val.length; i < n; i++) {
            node = this.jsonToXml(node, nsContext, descriptor, val[i]);
          }
          return node;
        }
      }
      if(isSimple && val !== null && typeof val === "object"){
        // check for $attributes field
        if (typeof val[this.options.attributesKey] !== "undefined"){
          attrs = val[this.options.attributesKey];
        }
        // add any $value field as xml element value
        if (typeof val[this.options.valueKey] !== "undefined"){
          val = val[this.options.valueKey];
        }
      }
      let element;
      let elementName;
      let xmlns;
      if (descriptor.form === 'unqualified') {
        elementName = name;
        nsContext.pushContext();
        nameSpaceContextCreated = true;
      } else if (descriptor.qname) {
        nsContext.pushContext();
        nameSpaceContextCreated = true;
        // get the mapping for the namespace uri
        let mapping = nsContext.getPrefixMapping(descriptor.qname.nsURI);
        let newlyDeclared = false;
        // if namespace not declared, declare it
        if (mapping === null || mapping.declared === false) {
          newlyDeclared = true;
          mapping = declareNamespace(nsContext, null,
          descriptor.qname.prefix, descriptor.qname.nsURI);
        }
        // add the element to a parent node
        let prefix = mapping ? mapping.prefix : descriptor.qname.prefix;
        elementName = prefix ? prefix + ':' + name : name;
        // if namespace is newly declared add the xmlns attribute
        if (newlyDeclared) {
          xmlns = prefix ? 'xmlns:' + prefix : 'xmlns';
        }
      }

      // add the element to a parent node
      if (isSimple && /<!\[CDATA/.test(val)) {
        element = node.element(elementName);
        val = val.replace("<![CDATA[","");
        val = val.replace("]]>","");
        element.cdata(val);
      }else if(isSimple && typeof val !== "undefined" && val !== null 
        && typeof val[this.options.xmlKey] !== "undefined") {
        val = val[this.options.xmlKey];        
        element = node.element(elementName);
        element.raw(val);
      }else {
        element = isSimple ? node.element(elementName, val) : node.element(elementName);
      } 

      if (xmlns && descriptor.qname.nsURI) {
        element.attribute(xmlns, descriptor.qname.nsURI);
      }

      if (isSimple) {
        if (attrs !== null) {
          // add each field in $attributes object as xml element attribute
          if (typeof attrs === "object") {
            for (let p in attrs) {
              let child = attrs[p];
              element.attribute(p, child);
            }
          }
        }
        if (val == null) {
          if (descriptor.isNillable) {
            // Set xsi:nil = true
            declareNamespace(nsContext, element, 'xsi', helper.namespaces.xsi);
            element.attribute('xsi:nil', true);
          }
        }
        if (nameSpaceContextCreated) {
          nsContext.popContext();
        }
        return node;
      } else if (typeof val !== 'undefined' && typeof val != null) {
        let attrs = val[this.options.attributesKey];
        if (typeof attrs === 'object') {
          for (let p in attrs) {
            let child = attrs[p];
            if (p === this.options.xsiTypeKey) {
              if (descriptor instanceof ElementDescriptor) {
                if (descriptor.refOriginal) {
                  if (descriptor.refOriginal.typeDescriptor) {
                    if (descriptor.refOriginal.typeDescriptor.inheritance){
                      let extension = descriptor.refOriginal.typeDescriptor.inheritance[child.type];
                      if (extension) {
                        descriptor.elements = descriptor.elements.concat(extension.elements);
                      }
                    }
                  }
                }
              }
            }
          }
        }  
      }

      if (typeof val !== 'undefined' && val !== null && ( typeof val !== 'object' || val instanceof Date)) {
        // for adding a field value nsContext.popContext() shouldnt be called
        element.text(val);
        if (nameSpaceContextCreated) {
          nsContext.popContext();
        }  
        return node;
      }

      this.mapObject(element, nsContext, descriptor, val);
      if (nameSpaceContextCreated) {
        nsContext.popContext();
      }  
      return node;
    }

    if (descriptor == null  || descriptor === undefined || descriptor instanceof TypeDescriptor) {
      this.mapObject(node, nsContext, descriptor, val);
      return node;
    }

    return node;
  }

  /**
   * Map a JSON object into an XML type
   * @param {XMLElement} node The root node
   * @param {NamespaceContext} nsContext Namespace context
   * @param {TypeDescriptor|ElementDescriptor} descriptor
   * @param {Object} val
   * @returns {*}
   */
  mapObject(node, nsContext, descriptor, val) {
    if (val == null) return node;
    if (typeof val !== 'object' || (val instanceof Date)) {
      node.text(val);
      return node;
    }

    var elements = {}, attributes = {};
    if (descriptor != null) {
      for (let i = 0, n = descriptor.elements.length; i < n; i++) {
        let elementDescriptor = descriptor.elements[i];
        let elementName = elementDescriptor.qname.name;
        elements[elementName] = elementDescriptor;
      }
    }

    if (descriptor != null) {
      for (let a in descriptor.attributes) {
        let attributeDescriptor = descriptor.attributes[a];
        let attributeName = attributeDescriptor.qname.name;
        attributes[attributeName] = attributeDescriptor;
      }
    }

    // handle later if value is an array 
    if (!Array.isArray(val)) {
      for (let p in val) {
        if (p === this.options.attributesKey)
          continue;
	      let child = val[p];
	      let childDescriptor = elements[p] || attributes[p];
	      if (childDescriptor == null) {
	        if (this.options.ignoreUnknownProperties) 
            continue;
          else 
            childDescriptor = new ElementDescriptor(
              QName.parse(p), null, 'unqualified', Array.isArray(child));
        }
        if (childDescriptor) {
          this.jsonToXml(node, nsContext, childDescriptor, child);
        }	
	    }
    }

    var attrs = val[this.options.attributesKey];
    if (attrs != null && typeof attrs === 'object') {
      for (let p in attrs) {
        let child = attrs[p];
        // if field is $xsiType add xsi:type attribute
        if (p === this.options.xsiTypeKey) {
          let xsiType;
          if(typeof child === 'object' && typeof child.type !== 'undefined') {
            // $xsiType has two fields - type, xmlns
            xsiType = QName.parse(child.type, child.xmlns);
          } else {
            xsiType = QName.parse(child);
          }
          declareNamespace(nsContext, node, 'xsi', helper.namespaces.xsi);
          let mapping = declareNamespace(nsContext, node, xsiType.prefix,
            xsiType.nsURI);
          let prefix = mapping ? mapping.prefix : xsiType.prefix;
          node.attribute('xsi:type', prefix ? prefix + ':' + xsiType.name :
            xsiType.name);
          continue;
        }
        let childDescriptor = attributes[p];
        if (childDescriptor == null) {
          if (this.options.ignoreUnknownProperties) continue;
          else {
            childDescriptor =
              new AttributeDescriptor(QName.parse(p), null, 'unqualified');
          }
        }
        this.jsonToXml(node, nsContext, childDescriptor, child);
      }
    }
    return node;
  }

  static createSOAPEnvelope(prefix, nsURI) {
    prefix = prefix || 'soap';
    var doc = xmlBuilder.create(prefix + ':Envelope',
      {version: '1.0', encoding: 'UTF-8', standalone: true});
    nsURI = nsURI || 'http://schemas.xmlsoap.org/soap/envelope/'
    doc.attribute('xmlns:' + prefix,
      'http://schemas.xmlsoap.org/soap/envelope/');
    let header = doc.element(prefix + ':Header');
    let body = doc.element(prefix + ':Body');
    return {
      body: body,
      header: header,
      doc: doc
    };
  }

  static createSOAPEnvelopeDescriptor(prefix, nsURI, parameterDescriptor) {
    prefix = prefix || 'soap';
    nsURI = nsURI || 'http://schemas.xmlsoap.org/soap/envelope/'
    var descriptor = new TypeDescriptor();

    var envelopeDescriptor = new ElementDescriptor(
      new QName(nsURI, 'Envelope', prefix), null, 'qualified', false);
    descriptor.addElement(envelopeDescriptor);

    var headerDescriptor = new ElementDescriptor(
      new QName(nsURI, 'Header', prefix), null, 'qualified', false);

    var bodyDescriptor = new ElementDescriptor(
      new QName(nsURI, 'Body', prefix), null, 'qualified', false);

    envelopeDescriptor.addElement(headerDescriptor);
    envelopeDescriptor.addElement(bodyDescriptor);

    if (parameterDescriptor && parameterDescriptor.body) {
      bodyDescriptor.add(parameterDescriptor.body);
    }

    if (parameterDescriptor && parameterDescriptor.headers) {
      bodyDescriptor.add(parameterDescriptor.headers);
    }

    if (parameterDescriptor && parameterDescriptor.faults) {
      var xsdStr = new QName(helper.namespaces.xsd, 'string', 'xsd');
      var faultDescriptor = new ElementDescriptor(
        new QName(nsURI, 'Fault', prefix), null, 'qualified', false);
      faultDescriptor.addElement(
        new ElementDescriptor(nsURI, 'faultcode', xsdStr, 'qualified', false));
      faultDescriptor.addElement(
        new ElementDescriptor(nsURI, 'faultstring', xsdStr, 'qualified', false));
      faultDescriptor.addElement(
        new ElementDescriptor(nsURI, 'faultactor', xsdStr, 'qualified', false));
      var detailDescriptor =
        new ElementDescriptor(nsURI, 'detail', null, 'qualified', false);
      faultDescriptor.addElement(detailDescriptor);

      for (var f in parameterDescriptor.faults) {
        detailDescriptor.add(parameterDescriptor.faults[f]);
      }
    }

    return descriptor;
  }

  /**
   * Parse XML string or stream into the XMLBuilder tree
   * @param root The root node
   * @param xml XML string or stream
   * @param cb
   * @returns {*}
   */
  static parseXml(root, xml, cb) {
    let parser;
    let stringMode = true;
    if (typeof xml === 'string') {
      stringMode = true;
      parser = sax.parser(true, {opt: {xmlns: true}});
    } else if (xml instanceof stream.Readable) {
      stringMode = false;
      parser = sax.createStream(true, {opt: {xmlns: true}});
    }
    if (!root) {
      root = xmlBuilder.begin();
    }
    let current = root;
    let stack = [root];

    parser.onerror = function(e) {
      // an error happened.
      if (cb) process.nextTick(cb);
    };

    parser.ontext = function(text) {
      // got some text.  t is the string of text.
      if (current.isDocument) return;
      text = text.trim();
      if (text) {
        current.text(text);
      }
    };

    parser.oncdata = function(text) {
      if (current.isDocument) return;
      text = text.trim();
      if (text) {
        current.cdata(text);
      }
    };

    parser.onopentag = function(node) {
      // opened a tag.  node has "name" and "attributes"
      let element = current.element(node.name);
      if (node.attributes) {
        element.attribute(node.attributes);
      }
      stack.push(element);
      current = element;
    };

    parser.onclosetag = function(nsName) {
      var top = stack.pop();
      assert(top === current);
      assert(top.name === nsName);
      current = stack[stack.length - 1];
    };

    parser.onend = function() {
      if (cb) process.nextTick(function() {
        // parser stream is done, and ready to have more stuff written to it.
        cb && cb(null, root);
      });
    };

    if (stringMode) {
      parser.write(xml).close();
    } else {
      xml.pipe(parser);
    }
    return root;
  }

  _processText(top, val) {
    // The parent element has xsi:nil = true
    if (top.object === null) return;
    // Top object has no other elements or attributes
    if (top.object === undefined) {
      top.object = val;
    } else if (top.object.constructor === Object) {
      // Top object already has attributes or elements
      let value = top.object[this.options.valueKey];
      if (value !== undefined) {
        top.object[this.options.valueKey] = value + val;
      } else {
        top.object[this.options.valueKey] = val;
      }
    } else {
      // Top object is other simple types, such as string or date
      top.object = top.object + val;
    }
  }

  xmlToJson(nsContext, xml, descriptor) {
    var self = this;
    var p = sax.parser(true);
    nsContext = nsContext || new NamespaceContext();
    var root = {};
    var refs = {}, id; // {id: {hrefs:[], obj:}, ...}
    var stack = [{name: null, object: root, descriptor: descriptor}];
    var options = this.options;

    p.onopentag = function(node) {
      nsContext.pushContext();
      var top = stack[stack.length - 1];
      var descriptor = top.descriptor;
      var nsName = node.name;
      var attrs = node.attributes;
      var obj = undefined;
      var elementAttributes = null;

      // Register namespaces 1st
      for (let a in attrs) {
        if (/^xmlns:|^xmlns$/.test(a)) {
          let prefix = (a === 'xmlns') ? '' : a.substring(6);
          nsContext.addNamespace(prefix, attrs[a]);
        }
      }

      // Handle regular attributes
      for (let a in attrs) {
        if (/^xmlns:|^xmlns$/.test(a)) continue;
        let qname = QName.parse(a);
        var isXsiType = false;
        var xsiType = null;
        var xsiXmlns = null;
        if (nsContext.getNamespaceURI(qname.prefix) === helper.namespaces.xsi) {
          // Handle xsi:*
          if (qname.name == 'nil') {
            // xsi:nil
            if (attrs[a] === 'true') {
              obj = null;
            }
            continue;
          } else if (qname.name === 'type') {
            // xsi:type
            isXsiType = true;
            xsiType = attrs[a];
            xsiType = QName.parse(xsiType);
            attrs[a] = xsiType.name;
            if(xsiType.prefix){
              xsiXmlns = nsContext.getNamespaceURI(xsiType.prefix);
            }  
          }
        }
        let attrName = qname.name;
        elementAttributes = elementAttributes || {};
        let attrDescriptor = descriptor && descriptor.findAttribute(qname.name);
        let attrValue = parseValue(attrs[a], attrDescriptor);
        // if element attribute is xsi:type add $xsiType field
        if (isXsiType) {
          // $xsiType object has two fields - type and xmlns
          xsiType = {};
          xsiType.type = attrs[a];
          xsiType.xmlns = xsiXmlns;
          elementAttributes[options.xsiTypeKey] = xsiType;
        } else {
          elementAttributes[attrName] = attrs[a];
        }
      }

      if (elementAttributes) {
        obj = {};
        obj[self.options.attributesKey] = elementAttributes;
      }

      var elementQName = QName.parse(nsName);
      elementQName.nsURI = nsContext.getNamespaceURI(elementQName.prefix);

      // SOAP href (#id)
      if (attrs.href != null) {
        id = attrs.href.substr(1);
        if (refs[id] === undefined) {
          refs[id] = {hrefs: [], object: null};
        }
        refs[id].hrefs.push({
          parent: top.object, key: elementQName.name, object: obj
        });
      }
      id = attrs.id;
      if (id != null) {
        if (refs[id] === undefined)
          refs[id] = {hrefs: [], object: null};
      }

      stack.push({
        name: elementQName.name,
        object: obj,
        descriptor: descriptor && descriptor.findElement(elementQName.name),
        id: attrs.id,
      });
    };

    p.onclosetag = function(nsName) {
      var elementName = QName.parse(nsName).name;
      nsContext.popContext();
      var current = stack.pop();
      var top = stack[stack.length - 1];
      if (top.object === undefined) {
        top.object = {};
      }
      if (top.object !== null) {
        if (typeof top.object === 'object' && elementName in top.object) {
          // The element exist already, let's create an array
          let val = top.object[elementName];
          if (Array.isArray(val)) {
            // Add to the existing array
            val.push(current.object);
          } else {
            // Convert the element value to an array
            top.object[elementName] = [val, current.object];
          }
        } else {
          top.object[elementName] = current.object;
        }
      }
      if (current.id != null) {
        refs[current.id].object = current.object;
      }
    };

    p.oncdata = function(text) {
      text = text && text.trim();
      if (!text.length)
        return;

      if (/<\?xml[\s\S]+\?>/.test(text)) {
        text = self.xmlToJson(null, text);
      }
      // add contents of CDATA to the xml output as a text
      p.handleJsonObject(text);
    };

    p.handleJsonObject = function(text) {
      var top = stack[stack.length - 1];
      self._processText(top, text);
    };
    
    p.ontext = function(text) {
      text = text && text.trim();
      if (!text.length)
        return;

      var top = stack[stack.length - 1];
      var descriptor = top.descriptor;
      var value = parseValue(text, descriptor);
      self._processText(top, value);
    };

    p.write(xml).close();

    // merge obj with href
    var merge = function(href, obj) {
      for (var j in obj) {
        if (obj.hasOwnProperty(j)) {
          href.obj[j] = obj[j];
        }
      }
    };

    // MultiRef support: merge objects instead of replacing
    for (let n in refs) {
      var ref = refs[n];
      for (var i = 0; i < ref.hrefs.length; i++) {
        merge(ref.hrefs[i], ref.object);
      }
    }

    if (root.Envelope) {
      var body = root.Envelope.Body;
      if (root.Envelope.Body !== undefined && root.Envelope.Body !== null) {
        if (body.Fault !== undefined && body.Fault !== null) {
          var errorMessage = 'Error occurred processing Fault response: ';
          var error;
          var code = selectn('faultcode', body.Fault);
          if (code) { //soap 1.1 fault
            var string = selectn('faultstring', body.Fault);
            var faultactor = selectn('faultactor', body.Fault);
            var detail = selectn('detail', body.Fault);
            errorMessage = errorMessage + 'faultcode : ' +  code +  ' faultstring: ' + string + ' ' +  'faultactor: ' +
                faultactor + ' detail: '  + JSON.stringify(detail);
          }
          code = selectn('Code', body.Fault);
          if (code) { //soap 1.2 fault
            var value = selectn('Value', body.Fault);
            var subCode = selectn('Subcode', body.Fault);
            var reason = selectn('Reason', body.Fault);
            var node = selectn('Node', body.Fault);
            var role = selectn('Role', body.Fault);
            var detail = selectn('Detail', body.Fault);
            errorMessage =  errorMessage + 'Code : ' +  JSON.stringify(code) +  ' Value: ' + value + ' Subcode: ' + JSON.stringify(subCode) +
                ' Reason: ' + JSON.stringify(reason)+ ' ' + 'Node : ' +  node +  ' Role: ' + role + ' '+ 'Detail' + JSON.stringify(detail);
          }
          error = new Error(errorMessage);
          error.root = root;
          throw error;
        }
      }
      return root.Envelope;
    }
    return root;
  }
}

function declareNamespace(nsContext, node, prefix, nsURI) {
  var mapping = nsContext.declareNamespace(prefix, nsURI);
  if (!mapping) {
    return false;
  } else if (node) {
    node.attribute('xmlns:' + mapping.prefix, mapping.uri);
    return mapping;
  } 
  return mapping;
}

function parseValue(text, descriptor) {
  if (typeof text !== 'string') return text;
  var value = text;
  var jsType = descriptor && descriptor.jsType;
  if (jsType === Date) {
    value = new Date(text);
  } else if (jsType === Boolean) {
    if (text === 'true') {
      value = true;
    } else {
      value = false;
    }
  } else if (typeof jsType === 'function') {
    value = jsType(text);
  }
  return value;
}

module.exports = XMLHandler;
