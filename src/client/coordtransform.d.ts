declare module 'coordtransform' {
  const transform: {
    wgs84togcj02(lng: number, lat: number): [number, number];
    gcj02tobd09(lng: number, lat: number): [number, number];
  };
  export default transform;
}
