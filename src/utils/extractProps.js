import isObject from 'lodash/isObject';

export default function extractProps(Component) {
  if (!Component || !Component.props) return {};
  if (Array.isArray(Component.props)) {
    return Component.props.reduce(
      (acc, prop) => {
        acc[prop]= {}
        return acc
      },
      {}
    )
  }
  if (isObject(Component.props)) {
    return Object.keys(Component.props).reduce(
      (acc, key) => {
        acc[key] = {}
        return acc
      },
      {}
    )
  }
  throw new TypeError('Component has invalid props');
}
