package main
import ("fmt"; "os")
func main(){ for i:=0;i<4000;i++ { fmt.Printf("go fixture line %d deterministic output\n",i) }; fail:=len(os.Args)>1&&os.Args[1]=="--fail"; if fail {fmt.Fprintln(os.Stderr,"go fixture intentional failure");os.Exit(7)};fmt.Fprintln(os.Stderr,"go fixture success") }
