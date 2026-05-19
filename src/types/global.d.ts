import 'react';

declare global {
  namespace JSX {
    type Element = React.JSX.Element;
    type ElementClass = React.JSX.ElementClass;
    type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
    interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
    interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
    interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
  }
}
