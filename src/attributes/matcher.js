import {tableNameForJoin} from '../utils';

// https://www.sqlite.org/faq.html#q14
// That's right. Two single quotes in a row…
export const singleQuoteEscapeSequence = "''";

// https://www.sqlite.org/fts5.html#section_3
export const doubleQuoteEscapeSequence = '""';


/**
The Matcher class encapsulates a particular comparison clause on an {@link Attribute}.
Matchers can evaluate whether or not an object matches them, and also compose
SQL clauses for the {@link RxDatabase}. Each matcher has a reference to a model
attribute, a comparator and a value. This class is heavily inspired by
NSPredicate on Mac OS X / CoreData.

```js

// Retrieving Matchers

const isUnread = Thread.attributes.unread.equal(true);

const hasLabel = Thread.attributes.categories.contains('label-id-123');

// Using Matchers in Database Queries

const db.findAll(Thread).where(isUnread)...

// Using Matchers to test Models

const threadA = new Thread({unread: true})
const threadB = new Thread({unread: false})

isUnread.evaluate(threadA)
// => true

isUnread.evaluate(threadB)
// => false

```
*/
class Matcher {
  constructor(attr, comparator, val) {
    this.attr = attr;
    this.comparator = comparator;
    this.val = val;

    this.muid = Matcher.muid;
    Matcher.muid = (Matcher.muid + 1) % 50;
  }

  attribute() {
    return this.attr;
  }

  value() {
    return this.val;
  }

  evaluate(model) {
    let modelValue = model[this.attr.modelKey];
    if (modelValue instanceof Function) {
      modelValue = modelValue()
    }
    const matcherValue = this.val;

    // Given an array of strings or models, and a string or model search value,
    // will find if a match exists.
    const modelArrayContainsValue = (array, searchItem) => {
      const asId = (v) => ((v && v.id) ? v.id : v);
      const search = asId(searchItem)
      for (const item of array) {
        if (asId(item) === search) {
          return true;
        }
      }
      return false;
    }

    switch (this.comparator) {
      case '=':
        return modelValue === matcherValue
      case '<':
        return modelValue < matcherValue
      case '>':
        return modelValue > matcherValue
      case '<=':
        return modelValue <= matcherValue
      case '>=':
        return modelValue >= matcherValue
      case 'in':
        return matcherValue.includes(modelValue)
      case 'contains':
        return modelArrayContainsValue(modelValue, matcherValue)
      case 'containsAny':
        return !!matcherValue.find((submatcherValue) => modelArrayContainsValue(modelValue, submatcherValue))
      case 'startsWith':
        return modelValue.startsWith(matcherValue)
      case 'like':
        return modelValue.search(new RegExp(`.*${matcherValue}.*`, "gi")) >= 0
      default:
        throw new Error(`Matcher.evaulate() not sure how to evaluate ${this.attr.modelKey} with comparator ${this.comparator}`)
    }
  }

  joinTableRef() {
    return `M${this.muid}`;
  }

  joinSQL(klass) {
    switch (this.comparator) {
      case 'contains':
      case 'containsAny': {
        const joinTable = tableNameForJoin(klass, this.attr.itemClass);
        const joinTableRef = this.joinTableRef();
        return `INNER JOIN \`${joinTable}\` AS \`${joinTableRef}\` ON \`${joinTableRef}\`.\`id\` = \`${klass.name}\`.\`id\``;
      }
      default:
        return false;
    }
  }

  whereSQL(klass) {
    const val = (this.comparator === "like") ? `%${this.val}%` : this.val;
    let escaped = null;

    if (typeof val === 'string') {
      escaped = `'${val.replace(/'/g, singleQuoteEscapeSequence)}'`;
    } else if (val === true) {
      escaped = 1
    } else if (val === false) {
      escaped = 0
    } else if (val instanceof Date) {
      escaped = val.getTime() / 1000
    } else if (val instanceof Array) {
      const escapedVals = []
      for (const v of val) {
        if (typeof v !== 'string') {
          throw new Error(`${this.attr.jsonKey} value ${v} must be a string.`);
        }
        escapedVals.push(`'${v.replace(/'/g, singleQuoteEscapeSequence)}'`);
      }
      escaped = `(${escapedVals.join(',')})`;
    } else {
      escaped = val;
    }

    switch (this.comparator) {
      case 'startsWith':
        return " RAISE `TODO`; ";
      case 'contains':
        return `\`${this.joinTableRef()}\`.\`value\` = ${escaped}`;
      case 'containsAny':
        return `\`${this.joinTableRef()}\`.\`value\` IN ${escaped}`;
      default:
        return `\`${klass.name}\`.\`${this.attr.jsonKey}\` ${this.comparator} ${escaped}`;
    }
  }
}

Matcher.muid = 0

/**
This subclass is publicly exposed as Matcher.Or.
@private
*/
class OrCompositeMatcher extends Matcher {
  constructor(children) {
    super();
    this.children = children;
  }

  attribute() {
    return null;
  }

  value() {
    return null;
  }

  evaluate(model) {
    return this.children.some((matcher) => matcher.evaluate(model));
  }

  joinSQL(klass) {
    const joins = []
    for (const matcher of this.children) {
      const join = matcher.joinSQL(klass);
      if (join) {
        joins.push(join);
      }
    }
    return (joins.length) ? joins.join(" ") : false;
  }

  whereSQL(klass) {
    const wheres = this.children.map((matcher) => matcher.whereSQL(klass));
    return `(${wheres.join(" OR ")})`;
  }
}

/**
This subclass is publicly exposed as Matcher.And.
@private
*/
class AndCompositeMatcher extends Matcher {
  constructor(children) {
    super();
    this.children = children;
  }

  attribute() {
    return null;
  }

  value() {
    return null;
  }

  evaluate(model) {
    return this.children.every((m) => m.evaluate(model));
  }

  joinSQL(klass) {
    const joins = []
    for (const matcher of this.children) {
      const join = matcher.joinSQL(klass);
      if (join) {
        joins.push(join);
      }
    }
    return joins;
  }

  whereSQL(klass) {
    const wheres = this.children.map((m) => m.whereSQL(klass));
    return `(${wheres.join(" AND ")})`;
  }
}

/**
This subclass is publicly exposed as Matcher.Not.
@private
*/
class NotCompositeMatcher extends AndCompositeMatcher {
  whereSQL(klass) {
    return `NOT (${super.whereSQL(klass)})`;
  }
}

Matcher.Or = OrCompositeMatcher
Matcher.And = AndCompositeMatcher
Matcher.Not = NotCompositeMatcher

export default Matcher;
